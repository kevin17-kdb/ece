import { esp32RegisterNames, type Esp32Assembly, type Esp32Diagnostic, type Esp32ListingEntry, type Esp32Symbol } from "./types";

export class Esp32AsmError extends Error {}

interface RawLine {
  lineNumber: number;
  label?: string;
  mnemonic?: string;
  operands: string[];
  text: string;
}

interface PassOneLine {
  raw: RawLine;
  address: number;
  size: number;
}

function stripComment(line: string): string {
  let result = line;
  for (const marker of [";", "//", "#"]) {
    const index = result.indexOf(marker);
    if (index >= 0) {
      result = result.slice(0, index);
    }
  }

  return result.trim();
}

function parseRegister(token: string, lineNumber: number): number {
  const name = token.trim().toLowerCase();
  const value = esp32RegisterNames[name];
  if (value === undefined) {
    throw new Esp32AsmError(`Line ${lineNumber}: unknown register "${token.trim()}".`);
  }

  return value;
}

function parseNumeric(token: string): number | undefined {
  const trimmed = token.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(body)) {
    value = parseInt(body, 16);
  } else if (/^0b[01]+$/i.test(body)) {
    value = parseInt(body.slice(2), 2);
  } else if (/^\d+$/.test(body)) {
    value = parseInt(body, 10);
  } else {
    return undefined;
  }

  return negative ? -value : value;
}

function parseImmediate(token: string, lineNumber: number, symbols: Map<string, number>): number {
  const trimmed = token.trim();
  const numeric = parseNumeric(trimmed);
  if (numeric !== undefined) {
    return numeric;
  }

  const symbol = symbols.get(trimmed);
  if (symbol !== undefined) {
    return symbol;
  }

  throw new Esp32AsmError(`Line ${lineNumber}: "${trimmed}" is not a number or a known label.`);
}

function parseMemoryOperand(token: string, lineNumber: number, symbols: Map<string, number>): { offset: number; register: number } {
  const match = /^(.+?)\((.+?)\)$/.exec(token.trim());
  if (!match) {
    throw new Esp32AsmError(`Line ${lineNumber}: expected an offset(base) operand, got "${token.trim()}".`);
  }

  return { offset: parseImmediate(match[1], lineNumber, symbols), register: parseRegister(match[2], lineNumber) };
}

function parseLines(source: string): RawLine[] {
  const lines = source.split(/\r?\n/);
  const result: RawLine[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let working = stripComment(line);
    if (working.length === 0) {
      return;
    }

    let label: string | undefined;
    const labelMatch = /^([A-Za-z_.][\w.]*)\s*:\s*(.*)$/.exec(working);
    if (labelMatch) {
      label = labelMatch[1];
      working = labelMatch[2].trim();
    }

    if (working.length === 0) {
      result.push({ lineNumber, label, operands: [], text: "" });
      return;
    }

    const spaceIndex = working.search(/\s/);
    const mnemonic = (spaceIndex === -1 ? working : working.slice(0, spaceIndex)).toLowerCase();
    const rest = spaceIndex === -1 ? "" : working.slice(spaceIndex).trim();
    const operands = rest.length === 0 ? [] : rest.split(",").map((operand) => operand.trim());

    result.push({ lineNumber, label, mnemonic, operands, text: working });
  });

  return result;
}

function signed12(value: number): boolean {
  return value >= -2048 && value <= 2047;
}

function instructionSize(mnemonic: string, operands: string[]): number {
  if (mnemonic === ".word") {
    return operands.length * 4;
  }

  if (mnemonic === ".byte") {
    return operands.length;
  }

  if (mnemonic === ".space") {
    const count = operands.length > 0 ? parseInt(operands[0], 10) : 0;
    return Number.isFinite(count) ? Math.max(0, count) : 0;
  }

  if (mnemonic === ".org" || mnemonic === ".text" || mnemonic === ".data" || mnemonic === ".globl") {
    return 0;
  }

  if (mnemonic === "li" && operands.length === 2) {
    const value = parseNumeric(operands[1]);
    return value !== undefined && !signed12(value) ? 8 : 4;
  }

  return 4;
}

function encodeR(opcode: number, rd: number, funct3: number, rs1: number, rs2: number, funct7: number): number {
  return ((funct7 & 0x7f) << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((funct3 & 0x7) << 12) | ((rd & 0x1f) << 7) | (opcode & 0x7f);
}

function encodeI(opcode: number, rd: number, funct3: number, rs1: number, imm: number): number {
  return (((imm & 0xfff)) << 20) | ((rs1 & 0x1f) << 15) | ((funct3 & 0x7) << 12) | ((rd & 0x1f) << 7) | (opcode & 0x7f);
}

function encodeS(opcode: number, funct3: number, rs1: number, rs2: number, imm: number): number {
  const value = imm & 0xfff;
  const imm11_5 = (value >> 5) & 0x7f;
  const imm4_0 = value & 0x1f;
  return (imm11_5 << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((funct3 & 0x7) << 12) | (imm4_0 << 7) | (opcode & 0x7f);
}

function encodeB(opcode: number, funct3: number, rs1: number, rs2: number, imm: number): number {
  const value = imm & 0x1fff;
  const imm12 = (value >> 12) & 1;
  const imm10_5 = (value >> 5) & 0x3f;
  const imm4_1 = (value >> 1) & 0xf;
  const imm11 = (value >> 11) & 1;
  return (imm12 << 31) | (imm10_5 << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((funct3 & 0x7) << 12) | (imm4_1 << 8) | (imm11 << 7) | (opcode & 0x7f);
}

function encodeU(opcode: number, rd: number, imm: number): number {
  return ((imm & 0xfffff) << 12) | ((rd & 0x1f) << 7) | (opcode & 0x7f);
}

function encodeJ(opcode: number, rd: number, imm: number): number {
  const value = imm & 0x1fffff;
  const imm20 = (value >> 20) & 1;
  const imm10_1 = (value >> 1) & 0x3ff;
  const imm11 = (value >> 11) & 1;
  const imm19_12 = (value >> 12) & 0xff;
  return (imm20 << 31) | (imm10_1 << 21) | (imm11 << 20) | (imm19_12 << 12) | ((rd & 0x1f) << 7) | (opcode & 0x7f);
}

function wordToBytes(word: number): number[] {
  return [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >>> 24) & 0xff];
}

const rType: Record<string, { funct3: number; funct7: number }> = {
  add: { funct3: 0x0, funct7: 0x00 },
  sub: { funct3: 0x0, funct7: 0x20 },
  and: { funct3: 0x7, funct7: 0x00 },
  or: { funct3: 0x6, funct7: 0x00 },
  xor: { funct3: 0x4, funct7: 0x00 },
};

const immediateType: Record<string, number> = {
  addi: 0x0,
  slli: 0x1,
  srli: 0x5,
};

const loadType: Record<string, number> = {
  lb: 0x0,
  lw: 0x2,
  lbu: 0x4,
};

const storeType: Record<string, number> = {
  sb: 0x0,
  sw: 0x2,
};

const branchType: Record<string, number> = {
  beq: 0x0,
  bne: 0x1,
  blt: 0x4,
  bge: 0x5,
};

export function assemble(source: string): Esp32Assembly {
  const parsed = parseLines(source);
  const diagnostics: Esp32Diagnostic[] = [];
  const symbols = new Map<string, number>();
  const symbolList: Esp32Symbol[] = [];

  let origin = 0;
  let address = 0;
  const passOne: PassOneLine[] = [];

  parsed.forEach((raw) => {
    if (raw.label) {
      if (symbols.has(raw.label)) {
        diagnostics.push({ severity: "error", message: `Duplicate label "${raw.label}".`, line: raw.lineNumber });
      } else {
        symbols.set(raw.label, address);
        symbolList.push({ name: raw.label, value: address, line: raw.lineNumber });
      }
    }

    if (!raw.mnemonic) {
      return;
    }

    if (raw.mnemonic === ".org") {
      if (raw.operands.length !== 1) {
        diagnostics.push({ severity: "error", message: ".org expects a single address.", line: raw.lineNumber });
      } else {
        try {
          address = parseImmediate(raw.operands[0], raw.lineNumber, symbols);
          origin = address;
        } catch (error) {
          diagnostics.push({ severity: "error", message: error instanceof Error ? error.message : String(error), line: raw.lineNumber });
        }
      }
      return;
    }

    if (raw.mnemonic === ".globl" || raw.mnemonic === ".text" || raw.mnemonic === ".data") {
      return;
    }

    if (raw.mnemonic === "li" && raw.operands.length === 2 && parseNumeric(raw.operands[1]) === undefined) {
      diagnostics.push({ severity: "error", message: `Line ${raw.lineNumber}: li requires a numeric constant (labels cannot be loaded with li).`, line: raw.lineNumber });
    }

    const size = instructionSize(raw.mnemonic, raw.operands);
    passOne.push({ raw, address, size });
    address += size;
  });

  const bytes: number[] = [];
  const listing: Esp32ListingEntry[] = [];

  if (passOne.length > 0) {
    origin = passOne[0].address;
  }

  passOne.forEach((entry) => {
    const { raw } = entry;
    const mnemonic = raw.mnemonic ?? "";
    const operands = raw.operands;
    const lineNumber = raw.lineNumber;

    try {
      const encoded = encodeInstruction(mnemonic, operands, lineNumber, entry.address, symbols);
      bytes.push(...encoded);
      listing.push({ line: lineNumber, address: entry.address, bytes: encoded, text: raw.text, label: raw.label });
    } catch (error) {
      diagnostics.push({ severity: "error", message: error instanceof Error ? error.message : String(error), line: lineNumber });
      listing.push({ line: lineNumber, address: entry.address, bytes: [], text: raw.text, label: raw.label });
    }
  });

  const codeEnd = passOne.length > 0 ? passOne[passOne.length - 1].address + passOne[passOne.length - 1].size : origin;

  if (diagnostics.length === 0) {
    diagnostics.push({ severity: "warning", message: "Assembled successfully.", line: 0 });
  }

  return {
    bytes,
    origin,
    entryPoint: origin,
    codeEnd,
    listing,
    symbols: symbolList,
    diagnostics,
  };
}

function encodeInstruction(mnemonic: string, operands: string[], lineNumber: number, address: number, symbols: Map<string, number>): number[] {
  const reg = (token: string) => parseRegister(token, lineNumber);
  const imm = (token: string) => parseImmediate(token, lineNumber, symbols);

  if (mnemonic === ".word") {
    return operands.flatMap((operand) => wordToBytes(imm(operand) >>> 0));
  }

  if (mnemonic === ".byte") {
    return operands.map((operand) => imm(operand) & 0xff);
  }

  if (mnemonic === ".space") {
    const count = parseInt(operands[0] ?? "0", 10);
    return new Array(Number.isFinite(count) ? Math.max(0, count) : 0).fill(0);
  }

  if (mnemonic === "nop") {
    return wordToBytes(encodeI(0x13, 0, 0x0, 0, 0));
  }

  if (mnemonic === "ebreak") {
    return wordToBytes(0x00100073);
  }

  if (mnemonic === "ecall") {
    return wordToBytes(0x00000073);
  }

  if (mnemonic === "mv") {
    if (operands.length !== 2) {
      throw new Esp32AsmError(`Line ${lineNumber}: mv expects rd, rs.`);
    }

    return wordToBytes(encodeI(0x13, reg(operands[0]), 0x0, reg(operands[1]), 0));
  }

  if (mnemonic === "li") {
    if (operands.length !== 2) {
      throw new Esp32AsmError(`Line ${lineNumber}: li expects rd, immediate.`);
    }

    const rd = reg(operands[0]);
    const value = imm(operands[1]);
    if (signed12(value)) {
      return wordToBytes(encodeI(0x13, rd, 0x0, 0, value));
    }

    const hi = ((value + 0x800) >> 12) & 0xfffff;
    const lo = ((value & 0xfff) << 20) >> 20;
    return [...wordToBytes(encodeU(0x37, rd, hi)), ...wordToBytes(encodeI(0x13, rd, 0x0, rd, lo))];
  }

  if (mnemonic === "ret") {
    return wordToBytes(encodeI(0x67, 0, 0x0, 1, 0));
  }

  if (mnemonic === "j" || mnemonic === "jal") {
    const rd = mnemonic === "j" ? 0 : operands.length === 2 ? reg(operands[0]) : 1;
    const targetToken = mnemonic === "j" ? operands[0] : operands[operands.length - 1];
    const target = imm(targetToken);
    return wordToBytes(encodeJ(0x6f, rd, target - address));
  }

  if (mnemonic === "jalr") {
    const rd = reg(operands[0]);
    const rs1 = reg(operands[1]);
    const offset = operands[2] ? imm(operands[2]) : 0;
    return wordToBytes(encodeI(0x67, rd, 0x0, rs1, offset));
  }

  if (mnemonic === "lui") {
    return wordToBytes(encodeU(0x37, reg(operands[0]), imm(operands[1]) & 0xfffff));
  }

  if (rType[mnemonic]) {
    const { funct3, funct7 } = rType[mnemonic];
    return wordToBytes(encodeR(0x33, reg(operands[0]), funct3, reg(operands[1]), reg(operands[2]), funct7));
  }

  if (immediateType[mnemonic] !== undefined) {
    const funct3 = immediateType[mnemonic];
    const isShift = mnemonic === "slli" || mnemonic === "srli";
    const value = isShift ? imm(operands[2]) & 0x1f : imm(operands[2]);
    return wordToBytes(encodeI(0x13, reg(operands[0]), funct3, reg(operands[1]), value));
  }

  if (loadType[mnemonic] !== undefined) {
    const memory = parseMemoryOperand(operands[1], lineNumber, symbols);
    return wordToBytes(encodeI(0x03, reg(operands[0]), loadType[mnemonic], memory.register, memory.offset));
  }

  if (storeType[mnemonic] !== undefined) {
    const memory = parseMemoryOperand(operands[1], lineNumber, symbols);
    return wordToBytes(encodeS(0x23, storeType[mnemonic], memory.register, reg(operands[0]), memory.offset));
  }

  if (branchType[mnemonic] !== undefined) {
    const target = imm(operands[2]);
    return wordToBytes(encodeB(0x63, branchType[mnemonic], reg(operands[0]), reg(operands[1]), target - address));
  }

  throw new Esp32AsmError(`Line ${lineNumber}: unknown instruction "${mnemonic}".`);
}
