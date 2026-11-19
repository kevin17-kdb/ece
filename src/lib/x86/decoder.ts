export type SegmentName = "es" | "cs" | "ss" | "ds";
export type GeneralRegisterName = "ax" | "bx" | "cx" | "dx" | "si" | "di" | "bp" | "sp";
export type ByteWidth = 8 | 16;

export interface RegisterOperand {
  kind: "register";
  width: ByteWidth;
  code: number;
  text: string;
}

export interface SegmentOperand {
  kind: "segment";
  width: 16;
  name: SegmentName;
  text: string;
}

export interface ImmediateOperand {
  kind: "immediate";
  width: ByteWidth;
  value: number;
  text: string;
}

export interface MemoryOperand {
  kind: "memory";
  width: ByteWidth;
  segment: SegmentName;
  base?: { name: string; value: number };
  index?: { name: string; value: number };
  displacement: number;
  effective: number;
  text: string;
}

export type Operand = RegisterOperand | SegmentOperand | ImmediateOperand | MemoryOperand;

export interface Instruction {
  length: number;
  mnemonic: string;
  operands: Operand[];
  segmentOverride: SegmentName | null;
  rep: "rep" | "repe" | "repne" | null;
  jumpTarget: number | null;
  interrupt: number | null;
  text: string;
}

export class X86DecodeError extends Error {
  constructor(message: string, readonly address: number) {
    super(message);
    this.name = "X86DecodeError";
  }
}

const aluNames = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
const group3Names: Record<number, string> = { 0: "test", 2: "not", 3: "neg", 4: "mul", 5: "imul", 6: "div", 7: "idiv" };
const group5Names: Record<number, string> = { 0: "inc", 1: "dec", 2: "call", 3: "call-far", 4: "jmp", 5: "jmp-far", 6: "push" };
const shiftNames = ["rol", "ror", "rcl", "rcr", "shl", "shr", "sal", "sar"];
const conditionNames = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];
const wordRegisters = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const byteRegisters = ["al", "cl", "dl", "bl", "ah", "ch", "dh", "bh"];
const segmentOrder: SegmentName[] = ["es", "cs", "ss", "ds"];
const prefixSegments: Record<number, SegmentName> = { 0x26: "es", 0x2e: "cs", 0x36: "ss", 0x3e: "ds" };

export interface DecodeRegisters {
  ax: number;
  bx: number;
  cx: number;
  dx: number;
  si: number;
  di: number;
  bp: number;
  sp: number;
  cs: number;
  ds: number;
  es: number;
  ss: number;
}

export interface DecodeState {
  registers: DecodeRegisters;
  memory: Uint8Array;
}

interface Cursor {
  index: number;
}

function mask(width: ByteWidth): number {
  return width === 8 ? 0xff : 0xffff;
}

export function formatHex(value: number, width: ByteWidth): string {
  const size = width === 8 ? 2 : 4;
  return `${(value & mask(width)).toString(16).toUpperCase().padStart(size, "0")}H`;
}

function formatImmediate(value: number, width: ByteWidth): string {
  return formatHex(value, width);
}

function formatDisplacement(value: number): string {
  if (value === 0) {
    return "";
  }

  return value > 0 ? `+${value}` : `${value}`;
}

function addressText(base: MemoryOperand): string {
  const parts: string[] = [];
  if (base.base) {
    parts.push(base.base.name.toUpperCase());
  }

  if (base.index) {
    parts.push(base.index.name.toUpperCase());
  }

  const displacement = formatDisplacement(base.displacement);
  if (displacement) {
    parts.push(displacement);
  }

  const prefix = base.base ? "" : `${base.segment.toUpperCase()}:`;
  return `${prefix}[${parts.join("+") || "0"}]`;
}

function physical(segment: number, offset: number): number {
  return ((segment << 4) + offset) & 0xfffff;
}

function signed(value: number, width: ByteWidth): number {
  const limit = 1 << (width - 1);
  const masked = value & mask(width);
  return masked >= limit ? masked - limit * 2 : masked;
}

export function decodeAt(state: DecodeState, offset: number): Instruction {
  const cursor: Cursor = { index: physical(state.registers.cs, offset) };
  let segmentOverride: SegmentName | null = null;
  let rep: "rep" | "repe" | "repne" | null = null;

  for (;;) {
    const byte = fetch(state, cursor);
    const prefix = prefixSegments[byte];
    if (prefix) {
      segmentOverride = prefix;
      continue;
    }

    if (byte === 0xf2) {
      rep = "repne";
      continue;
    }

    if (byte === 0xf3) {
      rep = "rep";
      continue;
    }

    const instruction = decodeOpcode(state, cursor, offset, byte, segmentOverride, rep);
    instruction.length = cursor.index - physical(state.registers.cs, offset);
    return instruction;
  }
}

function fetch(state: DecodeState, cursor: Cursor): number {
  const value = state.memory[cursor.index & 0xfffff];
  cursor.index += 1;
  return value;
}

function fetchWord(state: DecodeState, cursor: Cursor): number {
  return fetch(state, cursor) | (fetch(state, cursor) << 8);
}

function register(code: number, width: ByteWidth): RegisterOperand {
  return { kind: "register", width, code, text: (width === 8 ? byteRegisters : wordRegisters)[code].toUpperCase() };
}

function immediate(state: DecodeState, cursor: Cursor, width: ByteWidth): ImmediateOperand {
  const value = width === 8 ? fetch(state, cursor) : fetchWord(state, cursor);
  return { kind: "immediate", width, value, text: formatImmediate(value, width) };
}

function modrm(state: DecodeState, cursor: Cursor, width: ByteWidth, override: SegmentName | null): { reg: number; rm: Operand } {
  const code = fetch(state, cursor);
  const mod = code >> 6;
  const reg = (code >> 3) & 0x07;
  const rm = code & 0x07;

  if (mod === 3) {
    return { reg, rm: register(rm, width) };
  }

  const combinations: Array<{ base?: GeneralRegisterName; index?: GeneralRegisterName; usesStack: boolean }> = [
    { base: "bx", index: "si", usesStack: false },
    { base: "bx", index: "di", usesStack: false },
    { base: "bp", index: "si", usesStack: true },
    { base: "bp", index: "di", usesStack: true },
    { index: "si", usesStack: false },
    { index: "di", usesStack: false },
    { base: "bp", usesStack: true },
    { base: "bx", usesStack: false },
  ];

  if (rm === 6 && mod === 0) {
    const displacement = fetchWord(state, cursor);
    return {
      reg,
      rm: {
        kind: "memory",
        width,
        segment: override ?? "ds",
        displacement,
        effective: displacement & 0xffff,
        text: `${(override ?? "ds").toUpperCase()}:[${formatHex(displacement, 16)}]`,
      },
    };
  }

  const combination = combinations[rm];
  let displacement = 0;
  if (mod === 1) {
    displacement = signed(fetch(state, cursor), 8);
  } else if (mod === 2) {
    displacement = signed(fetchWord(state, cursor), 16);
  }

  const base = combination.base ? { name: combination.base, value: state.registers[combination.base] } : undefined;
  const index = combination.index ? { name: combination.index, value: state.registers[combination.index] } : undefined;
  const segment: SegmentName = override ?? (combination.usesStack ? "ss" : "ds");
  const operand: MemoryOperand = {
    kind: "memory",
    width,
    segment,
    base,
    index,
    displacement,
    effective: ((base?.value ?? 0) + (index?.value ?? 0) + displacement) & 0xffff,
    text: "",
  };
  operand.text = addressText(operand);
  return { reg, rm: operand };
}

function describe(instruction: Omit<Instruction, "text">): Instruction {
  const operands = instruction.operands.map((operand) => operand.text);
  const target = instruction.jumpTarget === null
    ? ""
    : ` ${formatHex(instruction.jumpTarget, 16)}`;
  const prefix = instruction.rep ? `${instruction.rep.toUpperCase()} ` : "";
  const text = operands.length > 0
    ? `${prefix}${instruction.mnemonic.toUpperCase()} ${operands.join(", ")}`
    : `${prefix}${instruction.mnemonic.toUpperCase()}`;
  return { ...instruction, text: `${text}${target}` };
}

function decodeOpcode(state: DecodeState, cursor: Cursor, offset: number, opcode: number, segmentOverride: SegmentName | null, rep: "rep" | "repe" | "repne" | null): Instruction {
  const base: Omit<Instruction, "text"> = {
    length: 0,
    mnemonic: "db",
    operands: [],
    segmentOverride,
    rep,
    jumpTarget: null,
    interrupt: null,
  };

  const unsupported = (name: string): never => {
    throw new X86DecodeError(`${name} (${opcode.toString(16).toUpperCase().padStart(2, "0")}H) is not supported by this 8086 core`, physical(state.registers.cs, offset));
  };

  const form = opcode & 0x07;
  const digit = (opcode >> 3) & 0x07;
  if (opcode < 0x40 && digit < 8 && form < 6) {
    const name = aluNames[digit];
    const width: ByteWidth = opcode & 1 ? 16 : 8;
    if (form < 4) {
      const { reg, rm } = modrm(state, cursor, width, segmentOverride);
      const regOperand = register(reg, width);
      return describe(form < 2 ? { ...base, mnemonic: name, operands: [rm, regOperand] } : { ...base, mnemonic: name, operands: [regOperand, rm] });
    }

    if (form === 4) {
      return describe({ ...base, mnemonic: name, operands: [register(0, width), immediate(state, cursor, width)] });
    }

    return describe({ ...base, mnemonic: name, operands: [register(0, width), immediate(state, cursor, 16)] });
  }

  if (opcode >= 0x40 && opcode <= 0x47) {
    return describe({ ...base, mnemonic: "inc", operands: [register(opcode - 0x40, 16)] });
  }

  if (opcode >= 0x48 && opcode <= 0x4f) {
    return describe({ ...base, mnemonic: "dec", operands: [register(opcode - 0x48, 16)] });
  }

  if (opcode >= 0x50 && opcode <= 0x57) {
    return describe({ ...base, mnemonic: "push", operands: [register(opcode - 0x50, 16)] });
  }

  if (opcode >= 0x58 && opcode <= 0x5f) {
    return describe({ ...base, mnemonic: "pop", operands: [register(opcode - 0x58, 16)] });
  }

  if (opcode === 0x68) {
    return describe({ ...base, mnemonic: "push", operands: [immediate(state, cursor, 16)] });
  }

  if (opcode === 0x6a) {
    return describe({ ...base, mnemonic: "push", operands: [immediate(state, cursor, 8)] });
  }

  if (opcode === 0x6c || opcode === 0x6d) {
    const width: ByteWidth = opcode === 0x6c ? 8 : 16;
    return describe({ ...base, mnemonic: "in", operands: [register(0, width), register(2, 16)] });
  }

  if (opcode === 0x6e || opcode === 0x6f) {
    const width: ByteWidth = opcode === 0x6e ? 8 : 16;
    return describe({ ...base, mnemonic: "out", operands: [register(2, 16), register(0, width)] });
  }

  if (opcode >= 0x70 && opcode <= 0x7f) {
    const relative = signed(fetch(state, cursor), 8);
    return describe({ ...base, mnemonic: `j${conditionNames[opcode - 0x70]}`, jumpTarget: (offset + 2 + relative) & 0xffff });
  }

  if (opcode === 0x80 || opcode === 0x81 || opcode === 0x83) {
    const width: ByteWidth = opcode === 0x80 ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    if (opcode === 0x83) {
      const value = signed(fetch(state, cursor), 8);
      return describe({ ...base, mnemonic: aluNames[reg], operands: [rm, { kind: "immediate", width: 16, value, text: formatImmediate(value, 8) }] });
    }

    const value = opcode === 0x81 ? fetchWord(state, cursor) : fetch(state, cursor);
    return describe({ ...base, mnemonic: aluNames[reg], operands: [rm, { kind: "immediate", width, value, text: formatImmediate(value, width) }] });
  }

  if (opcode === 0x84 || opcode === 0x85) {
    const width: ByteWidth = opcode === 0x84 ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    return describe({ ...base, mnemonic: "test", operands: [rm, register(reg, width)] });
  }

  if (opcode === 0x86 || opcode === 0x87) {
    const width: ByteWidth = opcode === 0x86 ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    return describe({ ...base, mnemonic: "xchg", operands: [rm, register(reg, width)] });
  }

  if (opcode === 0x88 || opcode === 0x89) {
    const width: ByteWidth = opcode === 0x88 ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    return describe({ ...base, mnemonic: "mov", operands: [rm, register(reg, width)] });
  }

  if (opcode === 0x8a || opcode === 0x8b) {
    const width: ByteWidth = opcode === 0x8a ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    return describe({ ...base, mnemonic: "mov", operands: [register(reg, width), rm] });
  }

  if (opcode === 0x8c) {
    const { reg, rm } = modrm(state, cursor, 16, segmentOverride);
    return describe({ ...base, mnemonic: "mov", operands: [rm, { kind: "segment", width: 16, name: segmentOrder[reg], text: segmentOrder[reg].toUpperCase() }] });
  }

  if (opcode === 0x8d) {
    const { reg, rm } = modrm(state, cursor, 16, segmentOverride);
    if (rm.kind !== "memory") {
      throw new X86DecodeError("LEA needs a memory operand", physical(state.registers.cs, offset));
    }

    return describe({ ...base, mnemonic: "lea", operands: [register(reg, 16), rm] });
  }

  if (opcode === 0x8e) {
    const { reg, rm } = modrm(state, cursor, 16, segmentOverride);
    return describe({ ...base, mnemonic: "mov", operands: [{ kind: "segment", width: 16, name: segmentOrder[reg], text: segmentOrder[reg].toUpperCase() }, rm] });
  }

  if (opcode === 0x8f) {
    const { rm } = modrm(state, cursor, 16, segmentOverride);
    return describe({ ...base, mnemonic: "pop", operands: [rm] });
  }

  if (opcode === 0x90) {
    return describe({ ...base, mnemonic: "nop" });
  }

  if (opcode === 0x98) {
    return describe({ ...base, mnemonic: "cbw" });
  }

  if (opcode === 0x99) {
    return describe({ ...base, mnemonic: "cwd" });
  }

  if (opcode === 0xa0 || opcode === 0xa1) {
    const width: ByteWidth = opcode === 0xa0 ? 8 : 16;
    const displacement = fetchWord(state, cursor);
    const memory: MemoryOperand = {
      kind: "memory",
      width,
      segment: segmentOverride ?? "ds",
      displacement,
      effective: displacement,
      text: `${(segmentOverride ?? "ds").toUpperCase()}:[${formatHex(displacement, 16)}]`,
    };
    return describe({ ...base, mnemonic: "mov", operands: [register(0, width), memory] });
  }

  if (opcode === 0xa2 || opcode === 0xa3) {
    const width: ByteWidth = opcode === 0xa2 ? 8 : 16;
    const displacement = fetchWord(state, cursor);
    const memory: MemoryOperand = {
      kind: "memory",
      width,
      segment: segmentOverride ?? "ds",
      displacement,
      effective: displacement,
      text: `${(segmentOverride ?? "ds").toUpperCase()}:[${formatHex(displacement, 16)}]`,
    };
    return describe({ ...base, mnemonic: "mov", operands: [memory, register(0, width)] });
  }

  const stringNames: Record<number, string> = { 0xa4: "movsb", 0xa5: "movsw", 0xa6: "cmpsb", 0xa7: "cmpsw", 0xaa: "stosb", 0xab: "stosw", 0xac: "lodsb", 0xad: "lodsw", 0xae: "scasb", 0xaf: "scasw" };
  if (stringNames[opcode]) {
    return describe({ ...base, mnemonic: stringNames[opcode] });
  }

  if (opcode >= 0xb0 && opcode <= 0xb7) {
    return describe({ ...base, mnemonic: "mov", operands: [register(opcode - 0xb0, 8), immediate(state, cursor, 8)] });
  }

  if (opcode >= 0xb8 && opcode <= 0xbf) {
    return describe({ ...base, mnemonic: "mov", operands: [register(opcode - 0xb8, 16), immediate(state, cursor, 16)] });
  }

  if (opcode === 0xc0 || opcode === 0xc1) {
    const width: ByteWidth = opcode === 0xc0 ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    return describe({ ...base, mnemonic: shiftNames[reg], operands: [rm, immediate(state, cursor, 8)] });
  }

  if (opcode === 0xc2) {
    return describe({ ...base, mnemonic: "ret", operands: [immediate(state, cursor, 16)] });
  }

  if (opcode === 0xc3) {
    return describe({ ...base, mnemonic: "ret" });
  }

  if (opcode === 0xc6) {
    const { rm } = modrm(state, cursor, 8, segmentOverride);
    return describe({ ...base, mnemonic: "mov", operands: [rm, immediate(state, cursor, 8)] });
  }

  if (opcode === 0xc7) {
    const { rm } = modrm(state, cursor, 16, segmentOverride);
    return describe({ ...base, mnemonic: "mov", operands: [rm, immediate(state, cursor, 16)] });
  }

  if (opcode === 0xcc) {
    return describe({ ...base, mnemonic: "int", interrupt: 3 });
  }

  if (opcode === 0xcd) {
    return describe({ ...base, mnemonic: "int", interrupt: fetch(state, cursor) });
  }

  if (opcode === 0xd0 || opcode === 0xd1) {
    const width: ByteWidth = opcode === 0xd0 ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    return describe({ ...base, mnemonic: shiftNames[reg], operands: [rm] });
  }

  if (opcode === 0xd2 || opcode === 0xd3) {
    const width: ByteWidth = opcode === 0xd2 ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    return describe({ ...base, mnemonic: shiftNames[reg], operands: [rm, register(1, 8)] });
  }

  if (opcode === 0xe0 || opcode === 0xe1 || opcode === 0xe2 || opcode === 0xe3) {
    const relative = signed(fetch(state, cursor), 8);
    const name = opcode === 0xe0 ? "loopne" : opcode === 0xe1 ? "loope" : opcode === 0xe2 ? "loop" : "jcxz";
    return describe({ ...base, mnemonic: name, jumpTarget: (offset + 2 + relative) & 0xffff });
  }

  if (opcode === 0xe4 || opcode === 0xe5) {
    const width: ByteWidth = opcode === 0xe4 ? 8 : 16;
    const value = fetch(state, cursor);
    return describe({ ...base, mnemonic: "in", operands: [register(0, width), { kind: "immediate", width: 8, value, text: formatHex(value, 8) }] });
  }

  if (opcode === 0xe6 || opcode === 0xe7) {
    const width: ByteWidth = opcode === 0xe6 ? 8 : 16;
    const port = fetch(state, cursor);
    return describe({ ...base, mnemonic: "out", operands: [{ kind: "immediate", width: 8, value: port, text: formatHex(port, 8) }, register(0, width)] });
  }

  if (opcode === 0xec || opcode === 0xed) {
    const width: ByteWidth = opcode === 0xec ? 8 : 16;
    return describe({ ...base, mnemonic: "in", operands: [register(0, width), register(2, 16)] });
  }

  if (opcode === 0xee || opcode === 0xef) {
    const width: ByteWidth = opcode === 0xee ? 8 : 16;
    return describe({ ...base, mnemonic: "out", operands: [register(2, 16), register(0, width)] });
  }

  if (opcode === 0xe8) {
    const relative = signed(fetchWord(state, cursor), 16);
    return describe({ ...base, mnemonic: "call", jumpTarget: (offset + 3 + relative) & 0xffff });
  }

  if (opcode === 0xe9) {
    const relative = signed(fetchWord(state, cursor), 16);
    return describe({ ...base, mnemonic: "jmp", jumpTarget: (offset + 3 + relative) & 0xffff });
  }

  if (opcode === 0xeb) {
    const relative = signed(fetch(state, cursor), 8);
    return describe({ ...base, mnemonic: "jmp", jumpTarget: (offset + 2 + relative) & 0xffff });
  }

  if (opcode === 0xf4) {
    return describe({ ...base, mnemonic: "hlt" });
  }

  if (opcode === 0xf5) {
    return describe({ ...base, mnemonic: "cmc" });
  }

  if (opcode === 0xf6 || opcode === 0xf7) {
    const width: ByteWidth = opcode === 0xf6 ? 8 : 16;
    const { reg, rm } = modrm(state, cursor, width, segmentOverride);
    const operands: Operand[] = [rm];
    if (reg === 0 || reg === 1) {
      operands.push(immediate(state, cursor, width));
    }

    return describe({ ...base, mnemonic: group3Names[reg] ?? "db", operands });
  }

  if (opcode === 0xf8) {
    return describe({ ...base, mnemonic: "clc" });
  }

  if (opcode === 0xf9) {
    return describe({ ...base, mnemonic: "stc" });
  }

  if (opcode === 0xfa) {
    return describe({ ...base, mnemonic: "cli" });
  }

  if (opcode === 0xfb) {
    return describe({ ...base, mnemonic: "sti" });
  }

  if (opcode === 0xfc) {
    return describe({ ...base, mnemonic: "cld" });
  }

  if (opcode === 0xfd) {
    return describe({ ...base, mnemonic: "std" });
  }

  if (opcode === 0xfe) {
    const { reg, rm } = modrm(state, cursor, 8, segmentOverride);
    if (reg > 1) {
      throw new X86DecodeError(`opcode FE ${reg}H is not a valid 8086 instruction`, physical(state.registers.cs, offset));
    }

    return describe({ ...base, mnemonic: reg === 0 ? "inc" : "dec", operands: [rm] });
  }

  if (opcode === 0xff) {
    const { reg, rm } = modrm(state, cursor, 16, segmentOverride);
    const mnemonic = group5Names[reg];
    if (!mnemonic || mnemonic.endsWith("-far")) {
      throw new X86DecodeError(`group 5 operation /${reg} is not supported by this 8086 core`, physical(state.registers.cs, offset));
    }

    return describe({ ...base, mnemonic, operands: [rm] });
  }

  if (opcode === 0x0f) {
    const secondary = fetch(state, cursor);
    if (secondary >= 0x80 && secondary <= 0x8f) {
      const relative = signed(fetchWord(state, cursor), 16);
      return describe({ ...base, mnemonic: `j${conditionNames[secondary - 0x80]}`, jumpTarget: (offset + 4 + relative) & 0xffff });
    }

    if (secondary === 0x1f) {
      modrm(state, cursor, 16, segmentOverride);
      return describe({ ...base, mnemonic: "nop" });
    }

    throw new X86DecodeError(`the two-byte opcode 0F ${secondary.toString(16).toUpperCase().padStart(2, "0")}H is not supported by this 8086 core`, physical(state.registers.cs, offset));
  }

  if ([0x06, 0x0e, 0x16, 0x1e].includes(opcode)) {
    const name = segmentOrder[{ 0x06: 0, 0x0e: 1, 0x16: 2, 0x1e: 3 }[opcode] as number];
    return describe({ ...base, mnemonic: "push", operands: [{ kind: "segment", width: 16, name, text: name.toUpperCase() }] });
  }

  if ([0x07, 0x17, 0x1f, 0x0f].includes(opcode)) {
    const name = segmentOrder[{ 0x07: 0, 0x17: 2, 0x1f: 3, 0x0f: 3 }[opcode] as number];
    return describe({ ...base, mnemonic: "pop", operands: [{ kind: "segment", width: 16, name, text: name.toUpperCase() }] });
  }

  if (opcode === 0x9a) {
    return unsupported("CALL far");
  }

  if (opcode === 0xea) {
    return unsupported("JMP far");
  }

  if ([0xc4, 0xc5].includes(opcode)) {
    return unsupported(opcode === 0xc4 ? "LES" : "LDS");
  }

  if (opcode === 0xc8) {
    return unsupported("ENTER");
  }

  if (opcode === 0xc9) {
    return unsupported("LEAVE");
  }

  if (opcode === 0xca) {
    return unsupported("RET far");
  }

  if (opcode === 0xcb) {
    return unsupported("RETF");
  }

  if (opcode === 0xce) {
    return unsupported("INTO");
  }

  if (opcode === 0xcf) {
    return unsupported("IRET");
  }

  if (opcode === 0xd4 || opcode === 0xd5) {
    return unsupported(opcode === 0xd4 ? "AAM" : "AAD");
  }

  if (opcode === 0xd6) {
    return unsupported("SALC");
  }

  if (opcode === 0xd7) {
    return unsupported("XLAT");
  }

  if (opcode === 0x27 || opcode === 0x2f) {
    return unsupported(opcode === 0x27 ? "DAA" : "DAS");
  }

  if (opcode === 0x37 || opcode === 0x3f) {
    return unsupported(opcode === 0x37 ? "AAA" : "AAS");
  }

  if (opcode === 0x60 || opcode === 0x61 || opcode === 0x62 || opcode === 0x63 || opcode === 0x64 || opcode === 0x65) {
    return unsupported(opcode === 0x60 ? "PUSHA" : opcode === 0x61 ? "POPA" : opcode === 0x62 ? "BOUND" : opcode === 0x63 ? "ARPL" : "segment override");
  }

  if (opcode === 0x9b) {
    return unsupported("WAIT");
  }

  return unsupported(`opcode ${opcode.toString(16).toUpperCase().padStart(2, "0")}H`);
}

export { wordRegisters, byteRegisters, segmentOrder, conditionNames, shiftNames, aluNames };
