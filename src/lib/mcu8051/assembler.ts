import { sfrNames, type X8051Assembly, type X8051Diagnostic, type X8051ListingEntry, type X8051Symbol } from "./types";

export class X8051AsmError extends Error {
  line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = "X8051AsmError";
    this.line = line;
  }
}

interface Line {
  number: number;
  label: string | null;
  mnemonic: string;
  operands: string[];
  text: string;
}

interface EncodeContext {
  line: number;
  address: number;
  symbols: Map<string, number>;
  lenient: boolean;
}

const registerNames = new Set(["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7"]);

export function assemble(source: string): X8051Assembly {
  const diagnostics: X8051Diagnostic[] = [];
  const lines = parseLines(source);
  const symbols = new Map<string, number>();
  const symbolList: X8051Symbol[] = [];
  const origin = 0;

  let address = origin;
  for (const line of lines) {
    if (line.mnemonic === "ORG") {
      const value = parseNumber(line.operands[0] ?? "");
      if (value === null) {
        diagnostics.push({ severity: "error", message: "ORG needs an address", line: line.number });
        continue;
      }

      address = value & 0xffff;
      if (line.label) {
        symbols.set(line.label.toUpperCase(), address);
        symbolList.push({ name: line.label, value: address, line: line.number });
      }

      continue;
    }

    if (line.label) {
      symbols.set(line.label.toUpperCase(), address);
      symbolList.push({ name: line.label, value: address, line: line.number });
    }

    if (line.mnemonic === "END") {
      break;
    }

    if (!line.mnemonic) {
      continue;
    }

    const encoded = encodeInstruction(line, { line: line.number, address, symbols, lenient: true });
    if (encoded.error) {
      diagnostics.push({ severity: "error", message: encoded.error, line: line.number });
      continue;
    }

    address = (address + encoded.bytes.length) & 0xffff;
  }

  const bytes: number[] = [];
  const listing: X8051ListingEntry[] = [];
  address = origin;
  for (const line of lines) {
    if (!line.mnemonic) {
      continue;
    }

    if (line.mnemonic === "ORG") {
      const value = parseNumber(line.operands[0] ?? "");
      if (value !== null) {
        address = value & 0xffff;
      }

      continue;
    }

    if (line.mnemonic === "END") {
      break;
    }

    if (line.mnemonic === "EQU") {
      continue;
    }

    const result = encodeInstruction(line, { line: line.number, address, symbols, lenient: false });
    if (result.error) {
      diagnostics.push({ severity: "error", message: result.error, line: line.number });
    } else {
      result.bytes.forEach((byte, index) => {
        const target = address + index;
        while (bytes.length <= target) {
          bytes.push(0);
        }

        bytes[target] = byte & 0xff;
      });

      listing.push({ line: line.number, address, bytes: result.bytes, text: line.text, symbol: line.label ?? undefined });
    }

    address += result.bytes.length;
  }

  return {
    bytes,
    origin,
    entryPoint: origin,
    codeEnd: address,
    listing,
    symbols: symbolList,
    diagnostics: diagnostics.length > 0 ? diagnostics : [{ severity: "warning", message: "Assembled successfully.", line: 0 }],
  };
}

function parseLines(source: string): Line[] {
  return source.split(/\r?\n/).map((raw, index) => {
    const number = index + 1;
    const withoutComment = raw.replace(/;.*$/, "");
    const text = withoutComment.trim();
    if (text.length === 0) {
      return { number, label: null, mnemonic: "", operands: [], text: "" };
    }

    let rest = text;
    let label: string | null = null;
    const labelMatch = /^([A-Za-z_$][\w$]*):/.exec(rest);
    if (labelMatch) {
      label = labelMatch[1];
      rest = rest.slice(labelMatch[0].length).trim();
    }

    if (rest.length === 0) {
      return { number, label, mnemonic: "", operands: [], text };
    }

    const pieces = rest.split(/\s+/);
    const mnemonic = pieces[0].toUpperCase();
    const operandText = rest.slice(pieces[0].length).trim();
    const operands = operandText.length === 0 ? [] : operandText.split(",").map((operand) => operand.trim()).filter((operand) => operand.length > 0);
    return { number, label, mnemonic, operands, text };
  });
}

function encodeInstruction(line: Line, context: EncodeContext): { bytes: number[]; error?: string } {
  try {
    return { bytes: encode(line, context) };
  } catch (error) {
    if (error instanceof X8051AsmError) {
      return { bytes: [], error: error.message };
    }

    throw error;
  }
}

function encode(line: Line, context: EncodeContext): number[] {
  const { mnemonic, operands } = line;
  switch (mnemonic) {
    case "NOP":
      return requireOperandCount(operands, 0, context) ?? [0x00];
    case "RET":
      return requireOperandCount(operands, 0, context) ?? [0x22];
    case "RETI":
      return requireOperandCount(operands, 0, context) ?? [0x32];
    case "MOV":
      return encodeMov(operands, context);
    case "MOVX":
      return encodeMovx(operands, context);
    case "MOVC":
      return encodeMovc(operands, context);
    case "ADD":
      return encodeArith(operands, context, 0x24, 0x25, 0x26, 0x28);
    case "ADDC":
      return encodeArith(operands, context, 0x34, 0x35, 0x36, 0x38);
    case "SUBB":
      return encodeArith(operands, context, 0x94, 0x95, 0x96, 0x98);
    case "ANL":
      return encodeLogical(operands, context, 0x54, 0x55, 0x56, 0x58, 0x53);
    case "ORL":
      return encodeLogical(operands, context, 0x44, 0x45, 0x46, 0x48, 0x43);
    case "XRL":
      return encodeLogical(operands, context, 0x64, 0x65, 0x66, 0x68, 0x63);
    case "INC":
      return encodeIncDec(operands, context, true);
    case "DEC":
      return encodeIncDec(operands, context, false);
    case "MUL":
      if ((operands[0] ?? "").toUpperCase() === "AB") {
        return [0xa4];
      }
      throw fail("MUL expects AB", context);
    case "DIV":
      if ((operands[0] ?? "").toUpperCase() === "AB") {
        return [0x84];
      }
      throw fail("DIV expects AB", context);
    case "CLR":
      return encodeClear(operands, context);
    case "CPL":
      return encodeComplement(operands, context);
    case "SETB":
      return encodeSetBit(operands, context);
    case "RR":
      return rotate(operands, context, 0x03);
    case "RRC":
      return rotate(operands, context, 0x13);
    case "RL":
      return rotate(operands, context, 0x23);
    case "RLC":
      return rotate(operands, context, 0x33);
    case "SWAP":
      return rotate(operands, context, 0xc4);
    case "LJMP":
      return encodeAbsJump(operands, context, 0x02);
    case "LCALL":
      return encodeAbsJump(operands, context, 0x12);
    case "SJMP":
      return encodeRelJump(operands, 1, context, 0x80);
    case "JZ":
      return encodeRelJump(operands, 1, context, 0x60);
    case "JNZ":
      return encodeRelJump(operands, 1, context, 0x70);
    case "JC":
      return encodeRelJump(operands, 1, context, 0x40);
    case "JNC":
      return encodeRelJump(operands, 1, context, 0x50);
    case "JB":
      return encodeBitJump(operands, context, 0x20);
    case "JNB":
      return encodeBitJump(operands, context, 0x30);
    case "JBC":
      return encodeBitJump(operands, context, 0x10);
    case "CJNE":
      return encodeCjne(operands, context);
    case "DJNZ":
      return encodeDjnz(operands, context);
    case "PUSH":
      requireOperandCount(operands, 1, context);
      return [0xc0, ...directBytes(operands[0], context)];
    case "POP":
      requireOperandCount(operands, 1, context);
      return [0xd0, ...directBytes(operands[0], context)];
    case "JMP":
      return [0x73];
    case "END":
    case "ORG":
    case "EQU":
      return [];
    default:
      throw fail(`Unknown instruction "${mnemonic}"`, context);
  }
}

function encodeMov(operands: string[], context: EncodeContext): number[] {
  requireOperandCount(operands, 2, context);
  const [dest, src] = operands;
  const destUpper = dest.toUpperCase();
  const srcUpper = src.toUpperCase();

  if (destUpper === "A") {
    if (src.startsWith("#")) {
      return [0x74, immediate(src, context)];
    }
    if (registerNames.has(srcUpper)) {
      return [0xe8 | registerIndex(srcUpper)];
    }
    if (isIndirect(src)) {
      return [0xe6 | indirectIndex(src, context)];
    }
    return [0xe5, ...directBytes(src, context)];
  }

  if (registerNames.has(destUpper)) {
    const index = registerIndex(destUpper);
    if (src.startsWith("#")) {
      return [0x78 | index, immediate(src, context)];
    }
    if (srcUpper === "A") {
      return [0xf8 | index];
    }
    return [0xa8 | index, ...directBytes(src, context)];
  }

  if (isIndirect(dest)) {
    const index = indirectIndex(dest, context);
    if (src.startsWith("#")) {
      return [0x76 | index, immediate(src, context)];
    }
    if (srcUpper === "A") {
      return [0xf6 | index];
    }
    return [0xa6 | index, ...directBytes(src, context)];
  }

  if (destUpper === "DPTR") {
    if (!src.startsWith("#")) {
      throw fail("MOV DPTR needs an immediate, e.g. MOV DPTR,#1000h", context);
    }

    const value = resolveValue(src.slice(1), context) & 0xffff;
    return [0x90, (value >> 8) & 0xff, value & 0xff];
  }

  if (destUpper === "C") {
    return [0xa2, resolveBit(src, context)];
  }

  if (isBitOperand(dest)) {
    if (srcUpper !== "C") {
      throw fail("Only MOV bit,C is supported for bit destinations", context);
    }

    return [0x92, resolveBit(dest, context)];
  }

  if (src.startsWith("#")) {
    return [0x75, ...directBytes(dest, context), immediate(src, context)];
  }

  if (srcUpper === "A") {
    return [0xf5, ...directBytes(dest, context)];
  }

  if (registerNames.has(srcUpper)) {
    return [0x88 | registerIndex(srcUpper), ...directBytes(dest, context)];
  }

  if (isIndirect(src)) {
    return [0x86 | indirectIndex(src, context), ...directBytes(dest, context)];
  }

  return [0x85, ...directBytes(src, context), ...directBytes(dest, context)];
}

function encodeMovx(operands: string[], context: EncodeContext): number[] {
  requireOperandCount(operands, 2, context);
  const [dest, src] = operands;
  const destUpper = dest.toUpperCase();
  const srcUpper = src.toUpperCase();

  if (destUpper === "A" && srcUpper === "@DPTR") {
    return [0xe0];
  }

  if (destUpper === "@DPTR" && srcUpper === "A") {
    return [0xf0];
  }

  if (destUpper === "A" && isRegisterIndirect(src)) {
    return [0xe2 | indirectIndex(src, context)];
  }

  if (isRegisterIndirect(dest) && srcUpper === "A") {
    return [0xf2 | indirectIndex(dest, context)];
  }

  throw fail("MOVX supports A <-> @DPTR or @Ri only", context);
}

function encodeMovc(operands: string[], context: EncodeContext): number[] {
  requireOperandCount(operands, 2, context);
  const [dest, src] = operands;
  const srcUpper = src.toUpperCase().replaceAll(" ", "");
  if (dest.toUpperCase() !== "A") {
    throw fail("MOVC destination must be A", context);
  }

  if (srcUpper === "@A+DPTR") {
    return [0x93];
  }

  if (srcUpper === "@A+PC") {
    return [0x83];
  }

  throw fail("MOVC source must be @A+DPTR or @A+PC", context);
}

function encodeArith(operands: string[], context: EncodeContext, imm: number, direct: number, indirect: number, register: number): number[] {
  requireOperandCount(operands, 2, context);
  const [dest, src] = operands;
  if (dest.toUpperCase() !== "A") {
    throw fail("Arithmetic destination must be A", context);
  }

  const srcUpper = src.toUpperCase();
  if (src.startsWith("#")) {
    return [imm, immediate(src, context)];
  }
  if (registerNames.has(srcUpper)) {
    return [register | registerIndex(srcUpper)];
  }
  if (isRegisterIndirect(src)) {
    return [indirect | indirectIndex(src, context)];
  }
  return [direct, ...directBytes(src, context)];
}

function encodeLogical(operands: string[], context: EncodeContext, immA: number, directA: number, indirectA: number, registerA: number, directImm: number): number[] {
  requireOperandCount(operands, 2, context);
  const [dest, src] = operands;
  const destUpper = dest.toUpperCase();
  const srcUpper = src.toUpperCase();

  if (destUpper === "A") {
    if (src.startsWith("#")) {
      return [immA, immediate(src, context)];
    }
    if (registerNames.has(srcUpper)) {
      return [registerA | registerIndex(srcUpper)];
    }
    if (isRegisterIndirect(src)) {
      return [indirectA | indirectIndex(src, context)];
    }
    return [directA, ...directBytes(src, context)];
  }

  if (src.startsWith("#")) {
    return [directImm, ...directBytes(dest, context), immediate(src, context)];
  }

  if (srcUpper === "A") {
    return [directImm & 0xfe, ...directBytes(dest, context)];
  }

  throw fail("Logical operations support A,target or direct,A / direct,#imm", context);
}

function encodeIncDec(operands: string[], context: EncodeContext, increment: boolean): number[] {
  requireOperandCount(operands, 1, context);
  const target = operands[0];
  const targetUpper = target.toUpperCase();
  if (targetUpper === "A") {
    return [increment ? 0x04 : 0x14];
  }
  if (targetUpper === "DPTR") {
    if (!increment) {
      throw fail("DEC does not support DPTR", context);
    }
    return [0xa3];
  }
  if (registerNames.has(targetUpper)) {
    return [(increment ? 0x08 : 0x18) | registerIndex(targetUpper)];
  }
  if (isRegisterIndirect(target)) {
    return [(increment ? 0x06 : 0x16) | indirectIndex(target, context)];
  }
  return [increment ? 0x05 : 0x15, ...directBytes(target, context)];
}

function encodeClear(operands: string[], context: EncodeContext): number[] {
  requireOperandCount(operands, 1, context);
  const target = operands[0];
  if (target.toUpperCase() === "A") {
    return [0xe4];
  }
  if (target.toUpperCase() === "C") {
    return [0xc3];
  }
  return [0xc2, resolveBit(target, context)];
}

function encodeComplement(operands: string[], context: EncodeContext): number[] {
  requireOperandCount(operands, 1, context);
  const target = operands[0];
  if (target.toUpperCase() === "A") {
    return [0xf4];
  }
  if (target.toUpperCase() === "C") {
    return [0xb3];
  }
  return [0xb2, resolveBit(target, context)];
}

function encodeSetBit(operands: string[], context: EncodeContext): number[] {
  requireOperandCount(operands, 1, context);
  const target = operands[0];
  if (target.toUpperCase() === "C") {
    return [0xd3];
  }
  return [0xd2, resolveBit(target, context)];
}

function rotate(operands: string[], context: EncodeContext, opcode: number): number[] {
  requireOperandCount(operands, 1, context);
  if (operands[0].toUpperCase() !== "A") {
    throw fail("Rotate instructions operate on A", context);
  }
  return [opcode];
}

function encodeAbsJump(operands: string[], context: EncodeContext, opcode: number): number[] {
  requireOperandCount(operands, 1, context);
  const value = resolveValue(operands[0], context) & 0xffff;
  return [opcode, (value >> 8) & 0xff, value & 0xff];
}

function encodeRelJump(operands: string[], expected: number, context: EncodeContext, opcode: number): number[] {
  requireOperandCount(operands, expected, context);
  const target = resolveValue(operands[operands.length - 1], context);
  return [opcode, relative(target, context, 2)];
}

function encodeBitJump(operands: string[], context: EncodeContext, opcode: number): number[] {
  requireOperandCount(operands, 2, context);
  return [opcode, resolveBit(operands[0], context), relative(resolveValue(operands[1], context), context, 3)];
}

function encodeCjne(operands: string[], context: EncodeContext): number[] {
  requireOperandCount(operands, 3, context);
  const [left, value, target] = operands;
  const destUpper = left.toUpperCase();
  const rel = relative(resolveValue(target, context), context, 3);

  if (destUpper === "A") {
    if (value.startsWith("#")) {
      return [0xb4, immediate(value, context), rel];
    }
    return [0xb5, ...directBytes(value, context), rel];
  }

  if (registerNames.has(destUpper)) {
    if (!value.startsWith("#")) {
      throw fail("CJNE Rn,#imm,rel requires an immediate", context);
    }
    return [0xb8 | registerIndex(destUpper), immediate(value, context), rel];
  }

  if (isRegisterIndirect(operands[0])) {
    return [0xb6 | indirectIndex(operands[0], context), immediate(operands[1], context), relative(resolveValue(operands[2], context), context, 3)];
  }

  throw fail("Unsupported CJNE form", context);
}

function encodeDjnz(operands: string[], context: EncodeContext): number[] {
  requireOperandCount(operands, 2, context);
  const [target, destination] = operands;
  const targetUpper = target.toUpperCase();
  if (registerNames.has(targetUpper)) {
    return [0xd8 | registerIndex(targetUpper), relative(resolveValue(destination, context), context, 2)];
  }
  return [0xd5, ...directBytes(target, context), relative(resolveValue(destination, context), context, 3)];
}

function relative(target: number, context: EncodeContext, instructionLength: number): number {
  let offset = (target - (context.address + instructionLength)) & 0xff;
  if (offset >= 0x80) {
    offset -= 0x100;
  }

  if (offset < -128 || offset > 127) {
    throw fail("Branch target is out of range", context);
  }

  return offset & 0xff;
}

function immediate(operand: string, context: EncodeContext): number {
  return resolveValue(operand.slice(1), context) & 0xff;
}

function directBytes(operand: string, context: EncodeContext): number[] {
  return [resolveValue(operand, context) & 0xff];
}

function registerIndex(name: string): number {
  return Number.parseInt(name.slice(1), 10);
}

function isRegisterIndirect(operand: string): boolean {
  const upper = operand.toUpperCase();
  return upper === "@R0" || upper === "@R1";
}

function isIndirect(operand: string): boolean {
  return operand.startsWith("@");
}

function isBitOperand(operand: string): boolean {
  return operand.includes(".");
}

function indirectIndex(operand: string, context: EncodeContext): number {
  const upper = operand.toUpperCase();
  if (upper === "@R0") {
    return 0;
  }
  if (upper === "@R1") {
    return 1;
  }
  throw fail(`Indirect addressing supports @R0 and @R1 (got ${operand})`, context);
}

function resolveValue(token: string, context: EncodeContext): number {
  const trimmed = token.trim();
  if (trimmed === "$") {
    return context.address;
  }

  const upper = trimmed.toUpperCase();
  if (upper in sfrNames) {
    return sfrNames[upper];
  }

  const number = parseNumber(trimmed);
  if (number !== null) {
    return number;
  }

  if (context.symbols.has(upper)) {
    return context.symbols.get(upper) as number;
  }

  if (context.lenient) {
    return 0;
  }

  throw fail(`Unknown symbol or number "${token}"`, context);
}

function resolveBit(token: string, context: EncodeContext): number {
  const trimmed = token.trim();
  const upper = trimmed.toUpperCase();
  if (upper === "C") {
    return 0xd7;
  }

  const dot = trimmed.indexOf(".");
  if (dot >= 0) {
    const base = resolveValue(trimmed.slice(0, dot), context);
    const bit = Number.parseInt(trimmed.slice(dot + 1), 10);
    if (Number.isNaN(bit) || bit < 0 || bit > 7) {
      throw fail(`Invalid bit index in "${token}"`, context);
    }

    if (base >= 0x80) {
      return (base + bit) & 0xff;
    }

    if (base >= 0x20 && base <= 0x2f) {
      return (base - 0x20) * 8 + bit;
    }

    throw fail(`"${token}" is not a bit-addressable location`, context);
  }

  const number = parseNumber(trimmed);
  if (number !== null) {
    return number & 0xff;
  }

  if (context.symbols.has(upper)) {
    return context.symbols.get(upper) as number;
  }

  if (context.lenient) {
    return 0;
  }

  throw fail(`Unknown bit address "${token}"`, context);
}

function parseNumber(token: string): number | null {
  const trimmed = token.trim();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 16);
  }

  if (/^[0-9][0-9a-f]*h$/i.test(trimmed) || /^[0-9a-f]+h$/i.test(trimmed)) {
    return Number.parseInt(trimmed.slice(0, -1), 16);
  }

  if (/^[01]+b$/i.test(trimmed)) {
    return Number.parseInt(trimmed.slice(0, -1), 2);
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  return null;
}

function requireOperandCount(operands: string[], expected: number, context: EncodeContext): number[] | null {
  if (operands.length !== expected) {
    throw fail(`Expected ${expected} operand(s), received ${operands.length}`, context);
  }

  return null;
}

function fail(message: string, context: EncodeContext): X8051AsmError {
  return new X8051AsmError(message, context.line);
}
