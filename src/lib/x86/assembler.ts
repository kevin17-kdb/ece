import {
  byteRegisterHigh,
  byteRegisterLow,
  conditionCodes,
  registerEncoding,
  segmentEncoding,
  type GeneralRegister,
  type SegmentRegister,
  type X86Assembly,
  type X86Diagnostic,
  type X86ListingEntry,
} from "./types";

export class X86AsmError extends Error {
  readonly reason: string;

  constructor(reason: string, readonly line: number) {
    super(line > 0 ? `line ${line}: ${reason}` : reason);
    this.name = "X86AsmError";
    this.reason = reason;
  }
}

type Expression =
  | { kind: "number"; value: number }
  | { kind: "symbol"; name: string }
  | { kind: "location" }
  | { kind: "unary"; op: "-" | "+"; operand: Expression }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: Expression; right: Expression };

type AddressRegisters = { base?: "bx" | "bp" | "si" | "di"; index?: "si" | "di" };

type MemoryOperand = AddressRegisters & {
  width: 8 | 16;
  explicit?: boolean;
  segment?: SegmentRegister;
  displacement?: Expression;
  direct: boolean;
  text: string;
};

type Operand =
  | { kind: "register"; name: string; width: 8 | 16 }
  | { kind: "segment"; name: SegmentRegister }
  | { kind: "immediate"; expr: Expression; width: 8 | 16 }
  | { kind: "memory"; memory: MemoryOperand };

type DataItem = { kind: "expr"; expr: Expression } | { kind: "string"; value: string };

type Statement = {
  line: number;
  label?: string;
  text: string;
  mnemonic: string;
  operands: Operand[];
  data?: DataItem[];
  address: number;
  forceShort: boolean;
  forceNear: boolean;
  repPrefix: number | null;
  segment?: SegmentRegister;
  listingIndex: number;
};

const registerNames = new Set([...Object.keys(registerEncoding), ...Object.keys(byteRegisterLow)]);
const segmentNames = new Set(Object.keys(segmentEncoding));
const addressRegisters = new Set(["bx", "bp", "si", "di"]);

const aluGroup: Record<string, number> = { add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7 };
const shiftGroup: Record<string, number> = { rol: 0, ror: 1, shl: 4, sal: 4, shr: 5, sar: 7 };
const group3Group: Record<string, number> = { not: 2, neg: 3, mul: 4, imul: 5, div: 6, idiv: 7 };
const stringOpcodes: Record<string, number> = {
  movsb: 0xa4,
  movsw: 0xa5,
  cmpsb: 0xa6,
  cmpsw: 0xa7,
  stosb: 0xaa,
  stosw: 0xab,
  lodsb: 0xac,
  lodsw: 0xad,
  scasb: 0xae,
  scasw: 0xaf,
};
const repPrefixes: Record<string, number> = { rep: 0xf3, repe: 0xf3, repz: 0xf3, repne: 0xf2, repnz: 0xf2 };
const stringInstructions = new Set(Object.keys(stringOpcodes));
const conditionOrder = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];
const segmentPrefixes = [0x26, 0x2e, 0x36, 0x3e];

const simpleOpcodes: Record<string, number> = {
  nop: 0x90,
  hlt: 0xf4,
  clc: 0xf8,
  stc: 0xf9,
  cmc: 0xf5,
  cld: 0xfc,
  std: 0xfd,
  cli: 0xfa,
  sti: 0xfb,
  cbw: 0x98,
  cwd: 0x99,
  int3: 0xcc,
};

const notImplemented = new Set([
  "aaa", "aas", "daa", "das", "aam", "aad", "les", "lds", "lss", "enter", "leave",
  "pusha", "popa", "pushad", "popad", "pushf", "popf", "lahf", "sahf", "xlat",
  "bound", "rcl", "rcr", "into", "wait", "insb", "outsb", "inw", "outw",
]);

const knownMnemonics = new Set([
  ...Object.keys(aluGroup),
  ...Object.keys(shiftGroup),
  ...Object.keys(group3Group),
  ...Object.keys(stringOpcodes),
  ...Object.keys(simpleOpcodes),
  ...Object.keys(repPrefixes),
  ...notImplemented,
  ...conditionOrder.map((code) => `j${code}`),
  ...Object.keys(conditionCodes),
  "mov", "lea", "test", "xchg", "push", "pop", "inc", "dec", "call", "ret", "retn",
  "jmp", "loop", "loope", "loopz", "loopne", "loopnz", "jcxz", "int", "in", "out",
  "cbw", "cwd", "db", "dw", "equ", "org", "ptr", "byte", "word", "short", "near",
]);

interface Token {
  value: string;
  column: number;
}

interface EncodeContext {
  resolve: (expr: Expression) => number;
  address: number;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isHexDigit(char: string): boolean {
  return isDigit(char) || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_.]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_.]/.test(char);
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'") {
      inString = !inString;
      continue;
    }

    if (char === ";" && !inString) {
      return line.slice(0, index);
    }
  }

  return line;
}

function parseNumberToken(token: string): number | null {
  const text = token.toLowerCase();

  if (/^\$[0-9a-f]+$/.test(text)) {
    return Number.parseInt(text.slice(1), 16);
  }

  if (/^0x[0-9a-f]+$/.test(text)) {
    return Number.parseInt(text.slice(2), 16);
  }

  if (/^0[0-9a-f]+[hq]$/.test(text)) {
    const digits = text.slice(1, -1);
    return text.endsWith("q") ? Number.parseInt(digits, 8) : Number.parseInt(digits, 16);
  }

  if (/^[0-9a-f]+h$/.test(text)) {
    return Number.parseInt(text.slice(0, -1), 16);
  }

  if (/^[01]+b$/.test(text)) {
    return Number.parseInt(text.slice(0, -1), 2);
  }

  if (/^[0-7]+[qo]$/.test(text)) {
    return Number.parseInt(text.slice(0, -1), 8);
  }

  if (/^[0-9]+[do]?$/.test(text)) {
    return Number.parseInt(text.replace(/[do]$/, ""), 10);
  }

  return null;
}

function tokenize(source: string, line: number): Token[] {
  const text = stripComment(source);
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) {
        throw new X86AsmError("unterminated character literal", line);
      }

      tokens.push({ value: `'${text.slice(index + 1, end)}'`, column: index });
      index = end + 1;
      continue;
    }

    if (isDigit(char) || (char === "$" && isHexDigit(text[index + 1] ?? ""))) {
      let end = index + 1;
      while (end < text.length && (isHexDigit(text[end]) || text[end] === "x" || text[end] === "X")) {
        end += 1;
      }

      if (end < text.length && "hHqQbBdDoO".includes(text[end])) {
        end += 1;
      }

      const numeric = text.slice(index, end);
      if (parseNumberToken(numeric) === null) {
        throw new X86AsmError(`invalid number "${numeric}"`, line);
      }

      tokens.push({ value: numeric, column: index });
      index = end;
      continue;
    }

    if (isIdentifierStart(char)) {
      let end = index + 1;
      while (end < text.length && isIdentifierPart(text[end])) {
        end += 1;
      }

      tokens.push({ value: text.slice(index, end), column: index });
      index = end;
      continue;
    }

    if ("[]()+-,*/:".includes(char)) {
      tokens.push({ value: char, column: index });
      index += 1;
      continue;
    }

    throw new X86AsmError(`unexpected character "${char}"`, line);
  }

  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(private readonly tokens: Token[], private readonly line: number) {}

  parse(): Expression {
    const value = this.parseAdditive();
    if (this.index < this.tokens.length) {
      throw new X86AsmError(`unexpected "${this.tokens[this.index].value}" in an expression`, this.line);
    }

    return value;
  }

  private peek(): string | null {
    return this.index < this.tokens.length ? this.tokens[this.index].value : null;
  }

  private parseAdditive(): Expression {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.peek();
      if (op !== "+" && op !== "-") {
        return left;
      }

      this.index += 1;
      left = { kind: "binary", op, left, right: this.parseMultiplicative() };
    }
  }

  private parseMultiplicative(): Expression {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek();
      if (op !== "*" && op !== "/") {
        return left;
      }

      this.index += 1;
      left = { kind: "binary", op, left, right: this.parseUnary() };
    }
  }

  private parseUnary(): Expression {
    const op = this.peek();
    if (op === "-" || op === "+") {
      this.index += 1;
      return { kind: "unary", op, operand: this.parseUnary() };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const token = this.tokens[this.index];
    if (!token) {
      throw new X86AsmError("expected a value", this.line);
    }

    if (token.value.toLowerCase() === "offset" || token.value.toLowerCase() === "seg") {
      this.index += 1;
      return this.parseUnary();
    }

    this.index += 1;

    if (token.value.startsWith("'")) {
      const inner = token.value.slice(1, -1);
      if (inner.length === 0) {
        throw new X86AsmError("empty character literal", this.line);
      }

      return { kind: "number", value: inner.charCodeAt(0) & 0xff };
    }

    if (token.value === "(") {
      const inner = this.parseAdditive();
      if (this.peek() !== ")") {
        throw new X86AsmError("expected a closing parenthesis", this.line);
      }

      this.index += 1;
      return inner;
    }

    if (token.value === "$") {
      return { kind: "location" };
    }

    const numeric = parseNumberToken(token.value);
    if (numeric !== null) {
      return { kind: "number", value: numeric };
    }

    if (isIdentifierStart(token.value[0])) {
      return { kind: "symbol", name: token.value };
    }

    throw new X86AsmError(`"${token.value}" cannot be used in an expression`, this.line);
  }
}

function splitOperands(tokens: Token[], line: number): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];

  for (const token of tokens) {
    if (token.value === ",") {
      if (current.length === 0) {
        throw new X86AsmError("empty operand", line);
      }

      groups.push(current);
      current = [];
      continue;
    }

    current.push(token);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function describeExpression(expr: Expression): string {
  switch (expr.kind) {
    case "number":
      return expr.value.toString();
    case "symbol":
      return expr.name;
    case "location":
      return "$";
    case "unary":
      return `${expr.op}${describeExpression(expr.operand)}`;
    default:
      return `${describeExpression(expr.left)} ${expr.op} ${describeExpression(expr.right)}`;
  }
}

function parseMemory(tokens: Token[], width: 8 | 16, segment: SegmentRegister | undefined, line: number): MemoryOperand {
  const inner = tokens.slice(1, -1);
  const memory: MemoryOperand = { width, segment, direct: true, text: "" };
  const seen: Record<string, boolean> = {};
  let displacement: Expression | undefined;
  let index = 0;
  let negative = false;

  const apply = (term: Expression) => {
    if (!displacement) {
      displacement = negative ? { kind: "unary", op: "-", operand: term } : term;
      negative = false;
      return;
    }

    displacement = { kind: "binary", op: negative ? "-" : "+", left: displacement, right: term };
    negative = false;
  };

  while (index < inner.length) {
    const token = inner[index];
    if (token.value === "+" || token.value === "-") {
      negative = token.value === "-";
      index += 1;
      continue;
    }

    const name = token.value.toLowerCase();
    if (addressRegisters.has(name)) {
      if (seen[name]) {
        throw new X86AsmError(`${name} is used twice in [${inner.map((item) => item.value).join(" ")}]`, line);
      }

      seen[name] = true;
      if (name === "bx" || name === "bp") {
        if (memory.base) {
          throw new X86AsmError("only one base register is allowed", line);
        }

        memory.base = name;
      } else {
        if (memory.index) {
          throw new X86AsmError("only one index register is allowed", line);
        }

        if (name !== "si" && name !== "di") {
          throw new X86AsmError(`${name} cannot be used as an index register`, line);
        }

        memory.index = name;
      }

      memory.direct = false;
      index += 1;
      continue;
    }

    if (registerNames.has(name)) {
      throw new X86AsmError(`${token.value} cannot be used for addressing`, line);
    }

    const start = index;
    let depth = 0;
    while (index < inner.length) {
      const value = inner[index].value;
      if (value === "(") {
        depth += 1;
      } else if (value === ")") {
        depth -= 1;
      } else if ((value === "+" || value === "-") && depth === 0) {
        break;
      }

      index += 1;
    }

    if (start === index) {
      throw new X86AsmError(`unexpected "${inner[index].value}" in an address`, line);
    }

    apply(new ExpressionParser(inner.slice(start, index), line).parse());
  }

  if (negative && displacement) {
    throw new X86AsmError("an address cannot end with '+' or '-'", line);
  }

  if (displacement) {
    memory.displacement = displacement;
    memory.direct = false;
  }

  memory.text = `[${inner.map((item) => item.value).join(" ")}]`;
  return memory;
}

function parseOperand(tokens: Token[], line: number, defaultWidth: 8 | 16 = 16, defaultSegment?: SegmentRegister): Operand {
  let rest = tokens;
  let width: 8 | 16 | null = null;

  const head = rest[0]?.value.toLowerCase();
  if (head === "byte" || head === "word") {
    width = head === "byte" ? 8 : 16;
    rest = rest.slice(1);
    if (rest[0]?.value.toLowerCase() === "ptr") {
      rest = rest.slice(1);
    }
  } else if (head === "ptr") {
    rest = rest.slice(1);
  }

  if (rest.length === 0) {
    throw new X86AsmError("expected an operand", line);
  }

  const [first] = rest;
  const name = first.value.toLowerCase();

  if (rest.length === 1 && registerNames.has(name)) {
    if (byteRegisterLow[name]) {
      if (width === 16) {
        throw new X86AsmError(`${name} is an 8-bit register`, line);
      }

      return { kind: "register", name, width: 8 };
    }

    if (width === 8) {
      throw new X86AsmError(`${name} is a 16-bit register`, line);
    }

    return { kind: "register", name, width: 16 };
  }

  if (rest.length === 1 && segmentNames.has(name)) {
    return { kind: "segment", name: name as SegmentRegister };
  }

  let segment: SegmentRegister | undefined;
  const colonIndex = rest.findIndex((token) => token.value === ":");
  if (colonIndex >= 0) {
    const segmentName = rest[colonIndex - 1]?.value.toLowerCase();
    if (!segmentName || !segmentNames.has(segmentName)) {
      throw new X86AsmError("expected a segment register before ':'", line);
    }

    segment = segmentName as SegmentRegister;
    rest = rest.slice(colonIndex + 1);
    if (rest.length === 0) {
      throw new X86AsmError("missing operand after a segment override", line);
    }
  }

  if (rest[0].value === "[") {
    if (rest[rest.length - 1].value !== "]") {
      throw new X86AsmError(`expected a closing ']' in ${rest.map((item) => item.value).join(" ")}`, line);
    }

    return { kind: "memory", memory: { ...parseMemory(rest, width ?? defaultWidth, segment ?? defaultSegment, line), explicit: width !== null } };
  }

  const expression = new ExpressionParser(rest, line).parse();
  if (width === 8) {
    return { kind: "immediate", expr: expression, width: 8 };
  }

  if (width === 16) {
    return { kind: "immediate", expr: expression, width: 16 };
  }

  return { kind: "immediate", expr: expression, width: defaultWidth };
}

function parseDataItems(groups: Token[][], line: number): DataItem[] {
  const items: DataItem[] = [];

  for (const group of groups) {
    if (group.length === 1 && group[0].value.startsWith("'")) {
      items.push({ kind: "string", value: group[0].value.slice(1, -1) });
      continue;
    }

    items.push({ kind: "expr", expr: new ExpressionParser(group, line).parse() });
  }

  return items;
}

function parseStatement(source: string, line: number): Statement {
  const tokens = tokenize(source, line);
  const statement: Statement = {
    line,
    text: source.trim(),
    mnemonic: "",
    operands: [],
    address: 0,
    forceShort: false,
    forceNear: false,
    repPrefix: null,
    listingIndex: -1,
  };

  if (tokens.length === 0) {
    return statement;
  }

  let index = 0;
  if (tokens[1]?.value === ":" && segmentNames.has(tokens[0].value.toLowerCase())) {
    statement.segment = tokens[0].value.toLowerCase() as SegmentRegister;
    index = 2;
  }

  const first = tokens[index].value.toLowerCase();
  const startsLabel = !registerNames.has(first) && isIdentifierStart(tokens[index].value[0]) && !knownMnemonics.has(first);
  if (tokens[index + 1]?.value === ":" && !registerNames.has(first) && !segmentNames.has(first)) {
    statement.label = tokens[index].value;
    index += 2;
  } else if (tokens[index + 1]?.value.toLowerCase() === "equ" && isIdentifierStart(tokens[index].value[0])) {
    statement.label = tokens[index].value;
    index += 1;
  } else if (startsLabel && (tokens.length > index + 1 || !knownMnemonics.has(first))) {
    statement.label = tokens[index].value;
    index += 1;
  }

  const mnemonicToken = tokens[index];
  if (!mnemonicToken) {
    if (!statement.label) {
      throw new X86AsmError("expected an instruction", line);
    }

    return statement;
  }

  let mnemonic = mnemonicToken.value.toLowerCase();
  let operandTokens = tokens.slice(index + 1);

  if (repPrefixes[mnemonic] !== undefined) {
    const next = operandTokens[0]?.value.toLowerCase();
    if (!next || !stringInstructions.has(next)) {
      throw new X86AsmError(`${mnemonic.toUpperCase()} must be followed by MOVS, CMPS, STOS, LODS or SCAS`, line);
    }

    statement.repPrefix = repPrefixes[mnemonic];
    mnemonic = next;
    operandTokens = operandTokens.slice(1);
  }

  if (notImplemented.has(mnemonic)) {
    throw new X86AsmError(`${mnemonic.toUpperCase()} is not supported by this assembler`, line);
  }

  statement.mnemonic = mnemonic;

  if (mnemonic === "db" || mnemonic === "dw") {
    statement.data = parseDataItems(splitOperands(operandTokens, line), line);
    return statement;
  }

  if (mnemonic === "equ") {
    statement.operands = [parseOperand(operandTokens, line)];
    return statement;
  }

  if (mnemonic === "byte" || mnemonic === "word") {
    throw new X86AsmError(`${mnemonic.toUpperCase()} must precede an operand, as in WORD PTR [BX]`, line);
  }

  const leading = operandTokens[0]?.value.toLowerCase();
  if (leading === "short" || leading === "near") {
    statement.forceShort = leading === "short";
    statement.forceNear = leading === "near";
    operandTokens = operandTokens.slice(1);
  }

  statement.operands = splitOperands(operandTokens, line).map((group) => parseOperand(group, line, 16, statement.segment));
  return statement;
}

function evaluate(expr: Expression, resolveSymbol: (name: string) => number | undefined, address: number, line: number): number | undefined {
  switch (expr.kind) {
    case "number":
      return expr.value;
    case "location":
      return address;
    case "symbol":
      return resolveSymbol(expr.name);
    case "unary": {
      const operand = evaluate(expr.operand, resolveSymbol, address, line);
      return operand === undefined ? undefined : expr.op === "-" ? -operand : operand;
    }
    default: {
      const left = evaluate(expr.left, resolveSymbol, address, line);
      const right = evaluate(expr.right, resolveSymbol, address, line);
      if (left === undefined || right === undefined) {
        return undefined;
      }

      switch (expr.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        default:
          if (right === 0) {
            throw new X86AsmError("division by zero in an expression", line);
          }

          return Math.trunc(left / right);
      }
    }
  }
}

function bytes16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function checkRange(value: number, width: 8 | 16, label: string, line: number, allowNegative: boolean): number {
  const mask = 2 ** width - 1;
  const min = allowNegative ? -(2 ** (width - 1)) : 0;
  if (value < min || value > mask) {
    throw new X86AsmError(`${label} ${value} does not fit in ${width} bits (${min} to ${mask})`, line);
  }

  return value & mask;
}

const rmCombinations: Array<{ code: number; base?: "bx" | "bp"; index?: "si" | "di" }> = [
  { code: 0, base: "bx", index: "si" },
  { code: 1, base: "bx", index: "di" },
  { code: 2, base: "bp", index: "si" },
  { code: 3, base: "bp", index: "di" },
  { code: 4, index: "si" },
  { code: 5, index: "di" },
  { code: 6, base: "bp" },
  { code: 7, base: "bx" },
];

function segmentPrefix(segment: SegmentRegister | undefined): number[] {
  return segment === undefined ? [] : [segmentPrefixes[segmentEncoding[segment]]];
}

function encodeModrm(reg: number, memory: MemoryOperand, ctx: EncodeContext, line: number, opcode: number[] = []): number[] {
  const prefix = segmentPrefix(memory.segment);

  if (!memory.base && !memory.index) {
    const offset = memory.displacement ? ctx.resolve(memory.displacement) : 0;
    return [...prefix, ...opcode, reg << 3 | 0x06, ...bytes16(checkRange(offset, 16, "offset", line, true))];
  }

  const match = rmCombinations.find((entry) => entry.base === memory.base && entry.index === memory.index);
  if (!match) {
    throw new X86AsmError(`${memory.text} is not an addressing mode the 8086 supports`, line);
  }

  if (!memory.displacement) {
    if (match.base === "bp" && !match.index) {
      return [...prefix, ...opcode, 0x40 | (reg << 3) | match.code, 0x00];
    }

    return [...prefix, ...opcode, reg << 3 | match.code];
  }

  const literal = literalValue(memory.displacement);
  if (literal !== undefined) {
    if (literal === 0 && match.base !== "bp") {
      return [...prefix, ...opcode, reg << 3 | match.code];
    }

    if (literal >= -128 && literal <= 127) {
      return [...prefix, ...opcode, 0x40 | (reg << 3) | match.code, literal & 0xff];
    }
  }

  const displacement = checkRange(ctx.resolve(memory.displacement), 16, "displacement", line, true);
  return [...prefix, ...opcode, 0x80 | (reg << 3) | match.code, ...bytes16(displacement)];
}

function literalValue(expr: Expression): number | undefined {
  if (expr.kind === "number") {
    return expr.value;
  }

  if (expr.kind === "unary" && expr.op === "-" && expr.operand.kind === "number") {
    return -expr.operand.value;
  }

  return undefined;
}

function registerCode(operand: Extract<Operand, { kind: "register" }>, line: number): number {
  const name = operand.name;
  if (byteRegisterLow[name]) {
    const base = byteRegisterLow[name] as GeneralRegister;
    return registerEncoding[base] + (byteRegisterHigh.has(name) ? 4 : 0);
  }

  if (!(name in registerEncoding)) {
    throw new X86AsmError(`unknown register "${name}"`, line);
  }

  return registerEncoding[name as GeneralRegister];
}

function immediateBytes(operand: Operand, ctx: EncodeContext, line: number, width: 8 | 16): number[] {
  if (operand.kind !== "immediate") {
    throw new X86AsmError(`expected an immediate value, found ${describeOperand(operand)}`, line);
  }

  const value = checkRange(ctx.resolve(operand.expr), width, "immediate", line, true);
  return width === 8 ? [value] : bytes16(value);
}

function requireMemory(operand: Operand, width: 8 | 16, line: number): MemoryOperand {
  if (operand.kind !== "memory") {
    throw new X86AsmError(`${describeOperand(operand)} is not a memory operand`, line);
  }

  if (operand.memory.width !== width) {
    throw new X86AsmError(`${operand.memory.text} is ${operand.memory.width}-bit, but ${width}-bit is required here`, line);
  }

  return operand.memory;
}

function requireRegister(operand: Operand | undefined, width: 8 | 16, line: number): Extract<Operand, { kind: "register" }> {
  if (!operand || operand.kind !== "register") {
    throw new X86AsmError(`${describeOperand(operand)} is not a ${width}-bit register`, line);
  }

  if (operand.width !== width) {
    throw new X86AsmError(`${operand.name} does not match the ${width}-bit operation`, line);
  }

  return operand;
}

function describeOperand(operand: Operand | undefined): string {
  if (!operand) {
    return "the missing operand";
  }

  switch (operand.kind) {
    case "register":
      return operand.name.toUpperCase();
    case "segment":
      return operand.name.toUpperCase();
    case "immediate":
      return describeExpression(operand.expr);
    default:
      return operand.memory.text;
  }
}

function operandWidth(operands: Operand[], line: number, context: string): 8 | 16 {
  const widths = new Set<8 | 16>();
  let ambiguousMemory = false;
  for (const operand of operands) {
    if (operand.kind === "register") {
      widths.add(operand.width);
    } else if (operand.kind === "memory") {
      if (operand.memory.explicit) {
        widths.add(operand.memory.width);
      } else {
        ambiguousMemory = true;
      }
    }
  }

  if (widths.size > 1) {
    throw new X86AsmError(`${context} operands must have the same size`, line);
  }

  if (widths.size === 0 && ambiguousMemory) {
    throw new X86AsmError(`${context} needs an explicit operand size (use BYTE or WORD)`, line);
  }

  return widths.size === 1 ? [...widths][0] : 16;
}

function encodeMove(operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const [destination, source] = operands;
  if (!destination || !source) {
    throw new X86AsmError("MOV needs two operands", line);
  }

  if (destination.kind === "memory" && source.kind === "memory") {
    throw new X86AsmError("MOV cannot move one memory operand into another", line);
  }

  if (source.kind === "segment") {
    const register = requireRegister(destination, 16, line);
    return [0x8c, registerCode(register, line) << 3 | segmentEncoding[source.name]];
  }

  if (destination.kind === "segment") {
    if (source.kind === "register") {
      return [0x8e, registerCode(source, line) << 3 | segmentEncoding[destination.name]];
    }

    return encodeModrm(segmentEncoding[destination.name], requireMemory(source, 16, line), ctx, line, [0x8e]);
  }

  const width = operandWidth(operands, line, "MOV");
  const directMemory = (operand: Operand): MemoryOperand | null => {
    if (operand.kind !== "memory") {
      return null;
    }

    return !operand.memory.base && !operand.memory.index ? operand.memory : null;
  };

  if (destination.kind === "register") {
    if (source.kind === "register") {
      const opcode = width === 8 ? 0x88 : 0x89;
      return [opcode, 0xc0 | registerCode(source, line) << 3 | registerCode(destination, line)];
    }

    if (source.kind === "memory") {
      const memory = requireMemory(source, width, line);
      const direct = directMemory(source);
      if (direct && !direct.segment) {
        const offset = direct.displacement ? ctx.resolve(direct.displacement) : 0;
        return [width === 8 ? 0xa0 : 0xa1, ...bytes16(checkRange(offset, 16, "offset", line, true))];
      }

      return encodeModrm(registerCode(destination, line), memory, ctx, line, [width === 8 ? 0x8a : 0x8b]);
    }

    const opcode = width === 8 ? 0xb0 : 0xb8;
    return [opcode + registerCode(destination, line), ...immediateBytes(source, ctx, line, width)];
  }

  if (source.kind === "register") {
    const memory = requireMemory(destination, width, line);
    const direct = directMemory(destination);
    if (direct && !direct.segment) {
      const offset = direct.displacement ? ctx.resolve(direct.displacement) : 0;
      return [width === 8 ? 0xa2 : 0xa3, ...bytes16(checkRange(offset, 16, "offset", line, true))];
    }

    return encodeModrm(registerCode(source, line), memory, ctx, line, [width === 8 ? 0x88 : 0x89]);
  }

  const memory = requireMemory(destination, width, line);
  return [...encodeModrm(0, memory, ctx, line, [width === 8 ? 0xc6 : 0xc7]), ...immediateBytes(source, ctx, line, width)];
}

function encodeAlu(alu: string, operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const digit = aluGroup[alu];
  const [destination, source] = operands;
  if (!destination || !source) {
    throw new X86AsmError(`${alu.toUpperCase()} needs two operands`, line);
  }

  if (destination.kind === "memory" && source.kind === "memory") {
    throw new X86AsmError(`${alu.toUpperCase()} cannot read and write memory in one instruction`, line);
  }

  const width = operandWidth(operands, line, alu.toUpperCase());

  if (destination.kind === "register" && source.kind === "register") {
    const opcode = (width === 8 ? 0x02 : 0x03) + digit * 8;
    return [opcode, 0xc0 | registerCode(destination, line) << 3 | registerCode(source, line)];
  }

  if (destination.kind === "memory" && source.kind === "register") {
    const opcode = (width === 8 ? 0x00 : 0x01) + digit * 8;
    return encodeModrm(registerCode(source, line), requireMemory(destination, width, line), ctx, line, [opcode]);
  }

  if (destination.kind === "register" && source.kind === "memory") {
    const opcode = (width === 8 ? 0x0a : 0x0b) + digit * 8;
    return encodeModrm(registerCode(destination, line), requireMemory(source, width, line), ctx, line, [opcode]);
  }

  if (source.kind === "immediate") {
    const value = ctx.resolve(source.expr);
    const accumulator = width === 8 ? "al" : "ax";
    if (destination.kind === "register" && destination.name === accumulator) {
      if (width === 8) {
        return [0x04 + digit * 8, checkRange(value, 8, "immediate", line, false)];
      }

      if (value >= -128 && value <= 127) {
        return [0x83, 0xc0 | digit << 3, value & 0xff];
      }

      return [0x05 + digit * 8, ...bytes16(checkRange(value, 16, "immediate", line, true))];
    }

    if (width === 8) {
      if (destination.kind === "register") {
        return [0x80, 0xc0 | (digit << 3) | registerCode(destination, line), checkRange(value, 8, "immediate", line, true)];
      }

      if (destination.kind !== "memory") {
        throw new X86AsmError(`${alu.toUpperCase()} does not accept ${describeOperand(destination)} and ${describeOperand(source)}`, line);
      }

      return [
        ...encodeModrm(digit, destination.memory, ctx, line, [0x80]),
        checkRange(value, 8, "immediate", line, true),
      ];
    }

    const short = source.expr.kind === "number" && value >= -128 && value <= 127;
    if (destination.kind === "register") {
      const modrm = [0xc0 | (digit << 3) | registerCode(destination, line)];
      return short ? [0x83, ...modrm, value & 0xff] : [0x81, ...modrm, ...bytes16(checkRange(value, 16, "immediate", line, true))];
    }

    if (destination.kind !== "memory") {
      throw new X86AsmError(`${alu.toUpperCase()} does not accept ${describeOperand(destination)} and ${describeOperand(source)}`, line);
    }

    if (short) {
      return [...encodeModrm(digit, destination.memory, ctx, line, [0x83]), value & 0xff];
    }

    return [...encodeModrm(digit, destination.memory, ctx, line, [0x81]), ...bytes16(checkRange(value, 16, "immediate", line, true))];
  }
  throw new X86AsmError(`${alu.toUpperCase()} does not accept ${describeOperand(destination)} and ${describeOperand(source)}`, line);
}

function encodeTest(operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const [destination, source] = operands;
  if (!destination || !source) {
    throw new X86AsmError("TEST needs two operands", line);
  }

  const width = operandWidth(operands, line, "TEST");
  if (destination.kind === "register" && source.kind === "register") {
    return [width === 8 ? 0x84 : 0x85, 0xc0 | registerCode(destination, line) << 3 | registerCode(source, line)];
  }

  if (source.kind !== "immediate") {
    throw new X86AsmError("TEST compares a register or memory operand with an immediate", line);
  }

  const opcode = [width === 8 ? 0xf6 : 0xf7];
  if (destination.kind === "register") {
    return [...opcode, 0xc0 | registerCode(destination, line), ...immediateBytes(source, ctx, line, width)];
  }

  if (destination.kind !== "memory") {
    throw new X86AsmError(`TEST does not accept ${describeOperand(destination)} and ${describeOperand(source)}`, line);
  }

  return [...encodeModrm(0, destination.memory, ctx, line, opcode), ...immediateBytes(source, ctx, line, width)];
}

function encodeGroup3(mnemonic: string, operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const digit = group3Group[mnemonic];
  const [destination] = operands;
  if (!destination || operands.length > 1) {
    throw new X86AsmError(`${mnemonic.toUpperCase()} takes a single register or memory operand`, line);
  }

  const width = operandWidth(operands, line, mnemonic.toUpperCase());
  const opcode = [width === 8 ? 0xf6 : 0xf7];
  if (destination.kind === "register") {
    return [...opcode, 0xc0 | (digit << 3) | registerCode(requireRegister(destination, width, line), line)];
  }

  if (destination.kind !== "memory") {
    throw new X86AsmError(`${mnemonic.toUpperCase()} takes a register or memory operand`, line);
  }

  return encodeModrm(digit, destination.memory, ctx, line, opcode);
}

function encodeIncDec(mnemonic: string, operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const [destination] = operands;
  if (!destination || operands.length > 1) {
    throw new X86AsmError(`${mnemonic.toUpperCase()} needs one operand`, line);
  }

  const width = operandWidth(operands, line, mnemonic.toUpperCase());
  const digit = mnemonic === "inc" ? 0 : 1;
  if (destination.kind === "register") {
    const register = requireRegister(destination, width, line);
    if (width === 16 && register.name === "ax") {
      return [0x40 + digit * 8];
    }

    const shortCode = incDecShortCodes[register.name];
    if (width === 8 && shortCode !== undefined) {
      return [0x04 + digit * 8 + shortCode];
    }

    return [0xff, 0xc0 | (digit << 3) | registerCode(register, line)];
  }

  return encodeModrm(digit, requireMemory(destination, width, line), ctx, line, [width === 8 ? 0xfe : 0xff]);
}

const incDecShortCodes: Record<string, number> = { al: 0, cl: 1, dl: 2, bl: 3 };

function encodeShift(mnemonic: string, operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const digit = shiftGroup[mnemonic];
  const [destination, source] = operands;
  if (!destination) {
    throw new X86AsmError(`${mnemonic.toUpperCase()} needs an operand`, line);
  }

  const width = operandWidth(operands, line, mnemonic.toUpperCase());
  const register = destination.kind === "register" ? requireRegister(destination, width, line) : null;
  const memory = destination.kind === "memory" ? requireMemory(destination, width, line) : null;

  let count: "one" | "cl" | "imm" = "one";
  if (source) {
    if (source.kind === "register" && source.name === "cx") {
      count = "cl";
    } else if (source.kind === "immediate") {
      count = "imm";
    } else {
      throw new X86AsmError(`${mnemonic.toUpperCase()} shifts by 1 or by CL`, line);
    }
  }

  if (count === "imm") {
    const opcode = width === 8 ? 0xc0 : 0xc1;
    const value = immediateBytes(source as Extract<Operand, { kind: "immediate" }>, ctx, line, 8);
    return memory
      ? [...encodeModrm(digit, memory, ctx, line, [opcode]), ...value]
      : [opcode, 0xc0 | (digit << 3) | registerCode(register as Extract<Operand, { kind: "register" }>, line), ...value];
  }

  if (count === "cl") {
    const opcode = width === 8 ? 0xd2 : 0xd3;
    return memory
      ? encodeModrm(digit, memory, ctx, line, [opcode])
      : [opcode, 0xc0 | (digit << 3) | registerCode(register as Extract<Operand, { kind: "register" }>, line)];
  }

  const opcode = width === 8 ? 0xd0 : 0xd1;
  return memory
    ? encodeModrm(digit, memory, ctx, line, [opcode])
    : [opcode, 0xc0 | (digit << 3) | registerCode(register as Extract<Operand, { kind: "register" }>, line)];
}

function encodeStack(mnemonic: "push" | "pop", operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const [operand] = operands;
  if (!operand) {
    throw new X86AsmError(`${mnemonic.toUpperCase()} needs one operand`, line);
  }

  if (operands.length > 1) {
    throw new X86AsmError(`${mnemonic.toUpperCase()} takes a single operand`, line);
  }

  if (operand.kind === "segment") {
    const codes: Record<string, number> = mnemonic === "push"
      ? { es: 0x06, cs: 0x0e, ss: 0x16, ds: 0x1e }
      : { es: 0x07, ss: 0x17, ds: 0x1f };

    const code = codes[operand.name];
    if (code === undefined) {
      throw new X86AsmError(`POP ${operand.name.toUpperCase()} does not exist on the 8086`, line);
    }

    return [code];
  }

  if (operand.kind === "register") {
    if (operand.width === 8) {
      throw new X86AsmError(`the 8086 stack holds 16-bit words, ${operand.name.toUpperCase()} cannot be pushed`, line);
    }

    return [(mnemonic === "push" ? 0x50 : 0x58) | registerCode(operand, line)];
  }

  if (operand.kind === "immediate") {
    if (mnemonic === "pop") {
      throw new X86AsmError("POP cannot take an immediate operand", line);
    }

    return [0x68, ...immediateBytes(operand, ctx, line, 16)];
  }

  const memory = requireMemory(operand, 16, line);
  return mnemonic === "push"
    ? encodeModrm(6, memory, ctx, line, [0xff])
    : encodeModrm(0, memory, ctx, line, [0x8f]);
}

function encodeTransfer(mnemonic: "xchg" | "lea", operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const [destination, source] = operands;
  if (!destination || !source) {
    throw new X86AsmError(`${mnemonic.toUpperCase()} needs two operands`, line);
  }

  if (mnemonic === "lea") {
    const register = requireRegister(destination, 16, line);
    const memory = requireMemory(source, 16, line);
    if (memory.direct) {
      throw new X86AsmError(`LEA needs a computed address such as [BX+SI], not ${memory.text}`, line);
    }

    return encodeModrm(registerCode(register, line), memory, ctx, line, [0x8d]);
  }

  const width = operandWidth(operands, line, "XCHG");
  if (destination.kind === "register" && source.kind === "register") {
    if (destination.name === "ax") {
      return [0x90 | registerCode(source, line)];
    }

    if (source.name === "ax") {
      return [0x90 | registerCode(destination, line)];
    }

    return [width === 8 ? 0x86 : 0x87, 0xc0 | registerCode(destination, line) << 3 | registerCode(source, line)];
  }

  if (source.kind === "register") {
    return encodeModrm(registerCode(source, line), requireMemory(destination, width, line), ctx, line, [width === 8 ? 0x86 : 0x87]);
  }

  if (destination.kind === "register") {
    return encodeModrm(registerCode(destination, line), requireMemory(source, width, line), ctx, line, [width === 8 ? 0x86 : 0x87]);
  }

  throw new X86AsmError("XCHG needs a register operand", line);
}

function encodeIo(mnemonic: "in" | "out", operands: Operand[], ctx: EncodeContext, line: number): number[] {
  const [first, second] = operands;
  if (!first || !second) {
    throw new X86AsmError(`${mnemonic.toUpperCase()} needs two operands`, line);
  }

  const portOf = (operand: Operand): { port: number; dynamic: boolean } => {
    if (operand.kind === "register" && operand.name === "dx") {
      return { port: 0, dynamic: true };
    }

    if (operand.kind === "immediate") {
      return { port: checkRange(ctx.resolve(operand.expr), 8, "port number", line, false), dynamic: false };
    }

    throw new X86AsmError(`the port must be DX or an 8-bit constant, not ${describeOperand(operand)}`, line);
  };

  const dataRegister = (operand: Operand): 1 | 2 => {
    if (operand.kind !== "register") {
      throw new X86AsmError(`${describeOperand(operand)} is not AL or AX`, line);
    }

    if (operand.width === 8) {
      if (operand.name !== "al") {
        throw new X86AsmError(`${mnemonic.toUpperCase()} can only transfer data through AL or AX, not ${operand.name.toUpperCase()}`, line);
      }

      return 1;
    }

    if (operand.name !== "ax") {
      throw new X86AsmError(`${mnemonic.toUpperCase()} can only transfer data through AL or AX, not ${operand.name.toUpperCase()}`, line);
    }

    return 2;
  };

  if (mnemonic === "in") {
    const width = dataRegister(first);
    const port = portOf(second);
    if (port.dynamic) {
      return [width === 1 ? 0xec : 0xed];
    }

    return [width === 1 ? 0xe4 : 0xe5, port.port];
  }

  const port = portOf(first);
  if (second.kind === "immediate") {
    if (port.dynamic) {
      throw new X86AsmError("OUT DX, immediate does not exist on the 8086", line);
    }

    return [0xe6, port.port, checkRange(ctx.resolve(second.expr), 8, "immediate", line, false)];
  }

  const width = dataRegister(second);
  if (port.dynamic) {
    return [width === 1 ? 0x6e : 0x6f];
  }

  return [width === 1 ? 0xe6 : 0xe7, port.port];
}

function encodeJump(mnemonic: string, operands: Operand[], statement: Statement, ctx: EncodeContext, line: number): number[] {
  const [operand] = operands;
  if (!operand && mnemonic !== "ret") {
    throw new X86AsmError(`${mnemonic.toUpperCase()} needs a target`, line);
  }

  const relativeTo = (length: number): number => {
    if (operand.kind !== "immediate") {
      throw new X86AsmError(`${mnemonic.toUpperCase()} needs a label`, line);
    }

    return ctx.resolve(operand.expr) - (ctx.address + length);
  };

  if (mnemonic === "call") {
    if (operand.kind !== "immediate") {
      return encodeModrm(2, requireMemory(operand, 16, line), ctx, line, [0xff]);
    }

    return [0xe8, ...bytes16(relativeTo(3))];
  }

  if (mnemonic === "ret") {
    if (operand && operand.kind === "immediate") {
      return [0xc2, ...immediateBytes(operand, ctx, line, 16)];
    }

    return [0xc3];
  }

  if (mnemonic === "loop" || mnemonic === "loope" || mnemonic === "loopz" || mnemonic === "loopne" || mnemonic === "loopnz") {
    const relative = relativeTo(2);
    if (relative < -128 || relative > 127) {
      throw new X86AsmError(`LOOP target is out of range, it must be within 128 bytes`, line);
    }

    const opcodes: Record<string, number> = { loop: 0xe2, loope: 0xe1, loopz: 0xe1, loopne: 0xe0, loopnz: 0xe0 };
    return [opcodes[mnemonic], relative & 0xff];
  }

  if (mnemonic === "jcxz" || mnemonic === "jecxz") {
    const relative = relativeTo(2);
    if (relative < -128 || relative > 127) {
      throw new X86AsmError("JCXZ target is out of range, it must be within 128 bytes", line);
    }

    return [0xe3, relative & 0xff];
  }

  const condition = conditionCodes[mnemonic];
  if (condition !== undefined) {
    if (statement.forceNear) {
      return [0x0f, 0x80 + conditionIndex(condition, line), ...bytes16(relativeTo(3))];
    }

    const relative = relativeTo(2);
    if (relative < -128 || relative > 127) {
      throw new X86AsmError(`${mnemonic.toUpperCase()} target is ${relative} bytes away, beyond the 128-byte range of a short jump (use NEAR)`, line);
    }

    return [0x70 + conditionIndex(condition, line), relative & 0xff];
  }

  if (operand.kind !== "immediate") {
    return encodeModrm(4, requireMemory(operand, 16, line), ctx, line, [0xff]);
  }

  if (statement.forceShort) {
    const relative = relativeTo(2);
    if (relative < -128 || relative > 127) {
      throw new X86AsmError(`JMP SHORT target is ${relative} bytes away, beyond the 128-byte range`, line);
    }

    return [0xeb, relative & 0xff];
  }

  return [0xe9, ...bytes16(relativeTo(3))];
}

const loopMnemonics = new Set(["loop", "loope", "loopz", "loopne", "loopnz", "jcxz", "jecxz"]);

function fixedSizeOfJump(statement: Statement): number {
  const { mnemonic, operands } = statement;
  if (mnemonic === "call") {
    return 3;
  }

  if (mnemonic === "ret") {
    return operands.length > 0 ? 3 : 1;
  }

  if (mnemonic === "jmp") {
    return statement.forceShort ? 2 : 3;
  }

  if (loopMnemonics.has(mnemonic)) {
    return 2;
  }

  if (conditionCodes[mnemonic] !== undefined) {
    return statement.forceNear ? 3 : 2;
  }

  return -1;
}

function sizeOfInstruction(statement: Statement, lenient: (expr: Expression) => number): number {
  const jumpSize = fixedSizeOfJump(statement);
  return jumpSize > 0 ? jumpSize : encodeInstruction(statement, lenient).length;
}

function conditionIndex(condition: string, line: number): number {
  const index = conditionOrder.indexOf(condition);
  if (index < 0) {
    throw new X86AsmError(`the condition "${condition}" is not implemented`, line);
  }

  return index;
}

function encodeInstruction(statement: Statement, resolve: (expr: Expression) => number): number[] {
  const { mnemonic, operands, line } = statement;
  const ctx: EncodeContext = { resolve, address: statement.address };

  if (mnemonic === "mov") {
    return encodeMove(operands, ctx, line);
  }

  if (aluGroup[mnemonic] !== undefined) {
    return encodeAlu(mnemonic, operands, ctx, line);
  }

  if (mnemonic === "test") {
    return encodeTest(operands, ctx, line);
  }

  if (mnemonic === "not" || mnemonic === "neg" || mnemonic === "mul" || mnemonic === "imul" || mnemonic === "div" || mnemonic === "idiv") {
    return encodeGroup3(mnemonic, operands, ctx, line);
  }

  if (mnemonic === "inc" || mnemonic === "dec") {
    return encodeIncDec(mnemonic, operands, ctx, line);
  }

  if (shiftGroup[mnemonic] !== undefined) {
    return encodeShift(mnemonic, operands, ctx, line);
  }

  if (mnemonic === "push" || mnemonic === "pop") {
    return encodeStack(mnemonic, operands, ctx, line);
  }

  if (mnemonic === "xchg" || mnemonic === "lea") {
    return encodeTransfer(mnemonic, operands, ctx, line);
  }

  if (mnemonic === "in" || mnemonic === "out") {
    return encodeIo(mnemonic, operands, ctx, line);
  }

  if (stringOpcodes[mnemonic] !== undefined) {
    if (operands.length > 0) {
      throw new X86AsmError(`${mnemonic.toUpperCase()} does not take operands`, line);
    }

    const opcode = stringOpcodes[mnemonic];
    const prefix = statement.repPrefix === null ? segmentPrefix(statement.segment) : [statement.repPrefix, ...segmentPrefix(statement.segment)];
    return [...prefix, opcode];
  }

  if (mnemonic === "int") {
    const [operand] = operands;
    if (!operand || operand.kind !== "immediate") {
      throw new X86AsmError("INT needs an 8-bit interrupt number", line);
    }

    return [0xcd, checkRange(ctx.resolve(operand.expr), 8, "interrupt number", line, false)];
  }

  if (simpleOpcodes[mnemonic] !== undefined) {
    if (operands.length > 0) {
      throw new X86AsmError(`${mnemonic.toUpperCase()} does not take operands`, line);
    }

    return [simpleOpcodes[mnemonic]];
  }

  if (mnemonic === "jmp" || mnemonic === "call" || mnemonic === "ret" || mnemonic === "loop" || mnemonic === "loope" || mnemonic === "loopz" || mnemonic === "loopne" || mnemonic === "loopnz" || mnemonic === "jcxz" || mnemonic === "jecxz" || conditionCodes[mnemonic] !== undefined) {
    return encodeJump(mnemonic, operands, statement, ctx, line);
  }

  throw new X86AsmError(`"${mnemonic.toUpperCase()}" is not an instruction this assembler knows`, line);
}

function dataBytes(statement: Statement, resolve: (expr: Expression) => number): number[] {
  const bytes: number[] = [];
  const width: 8 | 16 = statement.mnemonic === "db" ? 8 : 16;

  for (const item of statement.data ?? []) {
    if (item.kind === "string") {
      if (width === 16) {
        throw new X86AsmError("DW does not accept a string literal, use DB", statement.line);
      }

      for (const char of item.value) {
        bytes.push(char.charCodeAt(0) & 0xff);
      }

      continue;
    }

    const value = resolve(item.expr);
    if (width === 8) {
      if (value < -128 || value > 255) {
        throw new X86AsmError(`DB value ${value} is outside -128 to 255`, statement.line);
      }

      bytes.push(value & 0xff);
      continue;
    }

    if (value < -32768 || value > 65535) {
      throw new X86AsmError(`DW value ${value} is outside -32768 to 65535`, statement.line);
    }

    bytes.push(...bytes16(value & 0xffff));
  }

  return bytes;
}

function isData(statement: Statement): boolean {
  return statement.mnemonic === "db" || statement.mnemonic === "dw";
}

function isInstruction(statement: Statement): boolean {
  return statement.mnemonic !== "" && !isData(statement) && statement.mnemonic !== "equ" && statement.mnemonic !== "org";
}

export interface AssembleOptions {
  origin?: number;
}

export function assemble(source: string, options: AssembleOptions = {}): X86Assembly {
  const origin = options.origin ?? 0x100;
  const diagnostics: X86Diagnostic[] = [];
  const symbols = new Map<string, { value: number; line: number }>();
  const listing: X86ListingEntry[] = [];
  const statements: Statement[] = [];
  let address = origin;
  let entryPoint = -1;
  let pendingLabel: string | undefined;

  const lookup = (name: string, current: number, strict: boolean, line: number): number | undefined => {
    const entry = symbols.get(name.toLowerCase());
    if (entry) {
      return entry.value;
    }

    if (strict) {
      throw new X86AsmError(`"${name}" is not defined`, line);
    }

    void current;
    return undefined;
  };

  for (const [index, text] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const statement = parseStatement(text, lineNumber);

    if (statement.label) {
      const key = statement.label.toLowerCase();
      if (symbols.has(key)) {
        throw new X86AsmError(`the label "${statement.label}" is defined twice`, lineNumber);
      }

      symbols.set(key, { value: address, line: lineNumber });
    }

    if (statement.mnemonic === "equ") {
      const [operand] = statement.operands;
      if (!statement.label || !operand || operand.kind !== "immediate") {
        throw new X86AsmError("EQU needs a label and a constant", lineNumber);
      }

      const value = evaluate(operand.expr, (name) => lookup(name, address, false, lineNumber), address, lineNumber);
      if (value === undefined) {
        throw new X86AsmError(`the value of "${statement.label}" is not known yet`, lineNumber);
      }

      symbols.set(statement.label.toLowerCase(), { value, line: lineNumber });
      continue;
    }

    if (statement.mnemonic === "org") {
      const [operand] = statement.operands;
      if (!operand || operand.kind !== "immediate") {
        throw new X86AsmError("ORG needs a constant", lineNumber);
      }

      const value = evaluate(operand.expr, (name) => lookup(name, address, false, lineNumber), address, lineNumber);
      if (value === undefined || value < 0 || value > 0xffff) {
        throw new X86AsmError("ORG needs a constant between 0 and FFFFh", lineNumber);
      }

      address = value;
      continue;
    }

    statement.address = address;
    statement.listingIndex = listing.length;
    const lenient = (expr: Expression): number => evaluate(expr, (name) => lookup(name, address, false, lineNumber), address, lineNumber) ?? 0;
    if (statement.mnemonic === "") {
      pendingLabel = pendingLabel ?? statement.label;
      continue;
    }

    const size = isData(statement) ? dataBytes(statement, lenient).length : sizeOfInstruction(statement, lenient);

    if (isInstruction(statement) && entryPoint < 0) {
      entryPoint = address;
    }

    listing.push({
      line: lineNumber,
      address,
      bytes: new Array<number>(size).fill(0),
      text: statement.text,
      label: statement.label ?? pendingLabel,
    });
    pendingLabel = undefined;
    statements.push(statement);
    address += size;
  }

  if (entryPoint < 0) {
    throw new X86AsmError("the program contains no instructions", 0);
  }

  const end = address;
  const image = new Array<number>(end).fill(0);
  for (const statement of statements) {
    const entry = listing[statement.listingIndex];
    const strict = (expr: Expression): number => {
      const value = evaluate(expr, (name) => lookup(name, entry.address, true, statement.line), entry.address, statement.line);
      if (value === undefined) {
        throw new X86AsmError("this value could not be resolved", statement.line);
      }

      return value;
    };

    try {
      const bytes = statement.mnemonic === ""
        ? []
        : isData(statement) ? dataBytes(statement, strict) : encodeInstruction(statement, strict);
      if (bytes.length !== entry.bytes.length) {
        throw new X86AsmError(`internal size mismatch while encoding "${statement.text}"`, statement.line);
      }

      for (let offset = 0; offset < bytes.length; offset += 1) {
        image[entry.address + offset] = bytes[offset] & 0xff;
      }

      entry.bytes = bytes;
    } catch (error) {
      if (error instanceof X86AsmError) {
        diagnostics.push({ severity: "error", message: error.reason, line: statement.line });
        continue;
      }

      throw error;
    }
  }

  return {
    bytes: diagnostics.length > 0 ? [] : image,
    origin,
    entryPoint,
    codeEnd: end,
    listing,
    symbols: [...symbols.entries()]
      .map(([name, entry]) => ({ name, value: entry.value, line: entry.line }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    segments: [],
    diagnostics,
  };
}
