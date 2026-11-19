import {
  decodeAt,
  X86DecodeError,
  type ByteWidth,
  type Instruction,
  type MemoryOperand,
  type Operand,
  type SegmentName,
} from "./decoder";
import {
  flagBits,
  numberToFlags,
  type FlagKey,
  type MemoryAccess,
  type PortAccess,
  type X86Registers,
} from "./types";
import { createRegisters } from "./types";

export { X86DecodeError };

export class X86RuntimeError extends Error {
  constructor(message: string, readonly ip: number) {
    super(message);
    this.name = "X86RuntimeError";
  }
}

export interface X86Device {
  read(port: number): number;
  write(port: number, value: number): void;
}

export interface X86Context {
  registers: X86Registers;
  memory: Uint8Array;
  device: X86Device;
  output: string[];
  reads: MemoryAccess[];
  writes: MemoryAccess[];
  io: PortAccess[];
  halted: boolean;
  terminated: boolean;
}

export interface ExecutedInstruction {
  instruction: Instruction;
  nextIp: number;
  repeats: number;
}

export interface X86ContextOptions {
  entryPoint: number;
  stackSegment?: number;
  stackPointer?: number;
  dataSegment?: number;
}

export function createContext(memory: Uint8Array, device: X86Device, options: X86ContextOptions): X86Context {
  const registers = createRegisters();
  registers.ip = options.entryPoint & 0xffff;
  registers.ss = options.stackSegment ?? 0x1000;
  registers.sp = options.stackPointer ?? 0xfffe;
  registers.ds = options.dataSegment ?? 0x0000;
  registers.es = options.dataSegment ?? 0x0000;
  return {
    registers,
    memory,
    device,
    output: [],
    reads: [],
    writes: [],
    io: [],
    halted: false,
    terminated: false,
  };
}

function physical(segment: number, offset: number): number {
  return ((segment << 4) + offset) & 0xfffff;
}

function mask(width: ByteWidth): number {
  return width === 8 ? 0xff : 0xffff;
}

function signBit(width: ByteWidth): number {
  return width === 8 ? 0x80 : 0x8000;
}

function signedOf(value: number, bits: number): number {
  if (bits >= 32) {
    return value >= 0x80000000 ? value - 0x100000000 : value;
  }

  const shifted = value & ((1 << bits) - 1);
  const sign = 1 << (bits - 1);
  return shifted >= sign ? shifted - (1 << bits) : shifted;
}

function signedValue(value: number, width: ByteWidth): number {
  return signedOf(value, width);
}

function parityOf(value: number): boolean {
  let bits = value & 0xff;
  let count = 0;
  while (bits > 0) {
    count += bits & 1;
    bits >>= 1;
  }

  return count % 2 === 0;
}

export function getFlag(registers: X86Registers, key: FlagKey): boolean {
  const bit = flagBits.find(([name]) => name === key)?.[1] ?? 0;
  return (registers.flags & bit) !== 0;
}

export function setFlag(registers: X86Registers, key: FlagKey, value: boolean): void {
  const bit = flagBits.find(([name]) => name === key)?.[1] ?? 0;
  registers.flags = value ? registers.flags | bit : registers.flags & ~bit;
}

function commitFlags(registers: X86Registers, flags: Record<FlagKey, boolean>): void {
  for (const [key, value] of Object.entries(flags) as Array<[FlagKey, boolean]>) {
    setFlag(registers, key, value);
  }
}

function currentFlags(registers: X86Registers): Record<FlagKey, boolean> {
  const flags = numberToFlags(registers.flags);
  return { ...flags };
}

function addFlags(registers: X86Registers, left: number, right: number, carryIn: number, width: ByteWidth): number {
  const result = (left + right + carryIn) & mask(width);
  const carryMask = mask(width);
  const flag: Record<FlagKey, boolean> = {
    ...currentFlags(registers),
    cf: (left & carryMask) + (right & carryMask) + carryIn > carryMask,
    af: ((left & 0xf) + (right & 0xf) + carryIn) > 0xf,
    zf: result === 0,
    sf: (result & signBit(width)) !== 0,
    pf: parityOf(result),
    of: ((left ^ result) & (right ^ result) & signBit(width)) !== 0,
  };
  commitFlags(registers, flag);
  return result;
}

function subFlags(registers: X86Registers, left: number, right: number, borrowIn: number, width: ByteWidth): number {
  const result = (left - right - borrowIn) & mask(width);
  const flag: Record<FlagKey, boolean> = {
    ...currentFlags(registers),
    cf: (left & mask(width)) - (right & mask(width)) - borrowIn < 0,
    af: ((left & 0xf) - (right & 0xf) - borrowIn) < 0,
    zf: result === 0,
    sf: (result & signBit(width)) !== 0,
    pf: parityOf(result),
    of: ((left ^ right) & (left ^ result) & signBit(width)) !== 0,
  };
  commitFlags(registers, flag);
  return result;
}

function logicalFlags(registers: X86Registers, result: number, width: ByteWidth): void {
  const value = result & mask(width);
  commitFlags(registers, {
    ...currentFlags(registers),
    cf: false,
    of: false,
    af: false,
    zf: value === 0,
    sf: (value & signBit(width)) !== 0,
    pf: parityOf(value),
  });
}

function readMemory(context: X86Context, segment: number, offset: number, width: ByteWidth, mode: MemoryAccess["mode"] = "read"): number {
  const address = physical(segment, offset);
  let value = 0;
  for (let index = 0; index < width / 8; index += 1) {
    value |= context.memory[(address + index) & 0xfffff] << (index * 8);
  }

  context.reads.push({ segment, offset, address, size: width / 8 as 1 | 2, mode, value });
  return value & mask(width);
}

function writeMemory(context: X86Context, segment: number, offset: number, width: ByteWidth, value: number): void {
  const address = physical(segment, offset);
  const masked = value & mask(width);
  context.writes.push({ segment, offset, address, size: width / 8 as 1 | 2, mode: "write", value: masked });
  for (let index = 0; index < width / 8; index += 1) {
    context.memory[(address + index) & 0xfffff] = (masked >> (index * 8)) & 0xff;
  }
}

const registerNames = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"] as const;
const byteBaseNames = ["ax", "cx", "dx", "bx", "ax", "cx", "dx", "bx"] as const;

function registerName(code: number): (typeof registerNames)[number] {
  return registerNames[code];
}

function byteRegisterName(code: number): (typeof byteBaseNames)[number] {
  return byteBaseNames[code];
}

function readOperand(context: X86Context, operand: Operand): number {
  if (operand.kind === "register") {
    const name = operand.width === 8 ? byteRegisterName(operand.code) : registerName(operand.code);
    const current = context.registers[name];
    return operand.width === 8
      ? operand.code >= 4 ? (current >> 8) & 0xff : current & 0xff
      : current & 0xffff;
  }

  if (operand.kind === "segment") {
    return context.registers[operand.name] & 0xffff;
  }

  if (operand.kind === "immediate") {
    return operand.value & mask(operand.width);
  }

  return readMemory(context, context.registers[operand.segment], operand.effective, operand.width);
}

function writeOperand(context: X86Context, operand: Operand, value: number, ip: number): void {
  if (operand.kind === "segment") {
    context.registers[operand.name] = value & 0xffff;
    return;
  }

  if (operand.kind === "immediate") {
    throw new X86RuntimeError("cannot write to an immediate operand", ip);
  }

  if (operand.kind === "register") {
    const name = operand.width === 8 ? byteRegisterName(operand.code) : registerName(operand.code);
    if (operand.width === 8) {
      const current = context.registers[name];
      context.registers[name] = operand.code >= 4 ? (current & 0x00ff) | ((value & 0xff) << 8) : (current & 0xff00) | (value & 0xff);
      return;
    }

    context.registers[name] = value & 0xffff;
    return;
  }

  writeMemory(context, context.registers[operand.segment], operand.effective, operand.width, value);
}

function pushWord(context: X86Context, value: number): void {
  const { registers } = context;
  registers.sp = (registers.sp - 2) & 0xffff;
  writeMemory(context, registers.ss, registers.sp, 16, value);
}

function popWord(context: X86Context): number {
  const { registers } = context;
  const value = readMemory(context, registers.ss, registers.sp, 16);
  registers.sp = (registers.sp + 2) & 0xffff;
  return value;
}

function evaluateCondition(registers: X86Registers, condition: string): boolean {
  const flags = numberToFlags(registers.flags);
  const canonical = conditionAliases[condition] ?? condition;
  switch (canonical) {
    case "o":
      return flags.of;
    case "no":
      return !flags.of;
    case "b":
      return flags.cf;
    case "ae":
      return !flags.cf;
    case "e":
      return flags.zf;
    case "ne":
      return !flags.zf;
    case "be":
      return flags.cf || flags.zf;
    case "a":
      return !flags.cf && !flags.zf;
    case "s":
      return flags.sf;
    case "ns":
      return !flags.sf;
    case "p":
      return flags.pf;
    case "np":
      return !flags.pf;
    case "l":
      return flags.sf !== flags.of;
    case "ge":
      return flags.sf === flags.of;
    case "le":
      return flags.zf || flags.sf !== flags.of;
    default:
      return !flags.zf && flags.sf === flags.of;
  }
}

const conditionAliases: Record<string, string> = {
  z: "e",
  nz: "ne",
  c: "b",
  nc: "ae",
  nae: "b",
  nbe: "a",
  na: "be",
  pe: "p",
  po: "np",
  nge: "l",
  nle: "g",
  ng: "le",
};

function divideError(context: X86Context, ip: number): never {
  context.halted = true;
  throw new X86RuntimeError("divide error (the 8086 would raise interrupt 0)", ip);
}

function executeAlu(context: X86Context, mnemonic: string, destination: Operand, source: Operand, ip: number): void {
  const width = destination.width;
  const left = readOperand(context, destination);
  const right = readOperand(context, source);
  const carry = getFlag(context.registers, "cf") ? 1 : 0;
  const store = mnemonic !== "cmp" && mnemonic !== "test";

  let result: number;
  switch (mnemonic) {
    case "add":
      result = addFlags(context.registers, left, right, 0, width);
      break;
    case "adc":
      result = addFlags(context.registers, left, right, carry, width);
      break;
    case "sub":
    case "cmp":
      result = subFlags(context.registers, left, right, 0, width);
      break;
    case "sbb":
      result = subFlags(context.registers, left, right, carry, width);
      break;
    case "and":
    case "test":
      result = left & right;
      logicalFlags(context.registers, result, width);
      break;
    case "or":
      result = left | right;
      logicalFlags(context.registers, result, width);
      break;
    default:
      result = left ^ right;
      logicalFlags(context.registers, result, width);
      break;
  }

  if (store) {
    writeOperand(context, destination, result, ip);
  }
}

function executeShift(context: X86Context, mnemonic: string, destination: Operand, count: number, ip: number): void {
  const width = destination.width;
  const value = readOperand(context, destination) & mask(width);
  const bits = width;
  const shift = count === 0 ? 0 : count % bits;
  let result: number;
  let nextCarry: number;
  let overflow = getFlag(context.registers, "of");

  if (shift === 0) {
    return;
  }

  switch (mnemonic) {
    case "shl":
    case "sal": {
      result = (value << shift) & mask(width);
      nextCarry = shift <= bits ? (value >> (bits - shift)) & 1 : 0;
      overflow = shift === 1 ? ((result & signBit(width)) !== 0) !== (nextCarry !== 0) : overflow;
      break;
    }
    case "shr":
      result = value >>> shift;
      nextCarry = shift <= bits ? (value >> (shift - 1)) & 1 : 0;
      overflow = shift === 1 ? (value & signBit(width)) !== 0 : overflow;
      break;
    case "sar": {
      const signed = signedValue(value, width);
      result = (signed >> shift) & mask(width);
      nextCarry = (signed >> (shift - 1)) & 1;
      overflow = shift === 1 ? false : overflow;
      break;
    }
    case "rol": {
      const rotated = (value << shift) | (value >> (bits - shift));
      result = rotated & mask(width);
      nextCarry = (result >> (shift - 1)) & 1;
      overflow = shift === 1 ? ((result & signBit(width)) !== 0) !== (nextCarry !== 0) : overflow;
      break;
    }
    case "ror": {
      const rotated = (value >> shift) | (value << (bits - shift));
      result = rotated & mask(width);
      nextCarry = (result >> (bits - shift)) & 1;
      overflow = shift === 1 ? ((value & signBit(width)) !== 0) !== ((result & signBit(width)) !== 0) : overflow;
      break;
    }
    default:
      throw new X86RuntimeError(`${mnemonic.toUpperCase()} is not implemented by this core`, ip);
  }

  commitFlags(context.registers, {
    ...currentFlags(context.registers),
    cf: nextCarry === 1,
    of: overflow,
  });
  writeOperand(context, destination, result, ip);
}

function executeMultiply(context: X86Context, mnemonic: string, source: Operand): void {
  const width = source.width;
  const value = readOperand(context, source) & mask(width);
  const registers = context.registers;
  const signed = mnemonic === "imul";

  if (width === 8) {
    const left = registers.ax & 0xff;
    const right = value & 0xff;
    const result = signed ? signedValue(left, 8) * signedValue(right, 8) : left * right;
    registers.ax = result & 0xffff;
    const overflow = signed ? signedValue(result, 16) !== result : result > 0xff;
    commitFlags(registers, { ...currentFlags(registers), cf: overflow, of: overflow });
    return;
  }

  if (signed) {
    const result = signedValue(registers.ax, 16) * signedValue(value, 16);
    registers.ax = result & 0xffff;
    registers.dx = (result >> 16) & 0xffff;
    const overflow = result > 0x7fff || result < -0x8000;
    commitFlags(registers, { ...currentFlags(registers), cf: overflow, of: overflow });
    return;
  }

  const result = (registers.ax & 0xffff) * (value & 0xffff);
  registers.ax = result & 0xffff;
  registers.dx = Math.floor(result / 0x10000) & 0xffff;
  const overflow = registers.dx !== 0;
  commitFlags(registers, { ...currentFlags(registers), cf: overflow, of: overflow });
}

function executeDivide(context: X86Context, mnemonic: string, source: Operand, ip: number): void {
  const width = source.width;
  const value = readOperand(context, source) & mask(width);
  const registers = context.registers;
  const signed = mnemonic === "idiv";

  if (value === 0) {
    divideError(context, ip);
  }

  if (width === 8) {
    const dividend = ((registers.ax >> 8) << 8) | (registers.ax & 0xff);
    if (signed) {
      const divisor = signedValue(value, 8);
      const numerator = signedValue(dividend, 16);
      const quotient = Math.trunc(numerator / divisor);
      if (quotient > 127 || quotient < -128) {
        divideError(context, ip);
      }

      registers.ax = (((numerator % divisor) << 8) | (quotient & 0xff)) & 0xffff;
      return;
    }

    const quotient = Math.floor(dividend / value);
    if (quotient > 0xff) {
      divideError(context, ip);
    }

    registers.ax = (((dividend % value) << 8) | (quotient & 0xff)) & 0xffff;
    return;
  }

  const dividend = ((registers.dx << 16) | (registers.ax & 0xffff)) >>> 0;
  if (signed) {
    const divisor = signedValue(value, 16);
    const numerator = signedOf(dividend, 32);
    const quotient = Math.trunc(numerator / divisor);
    if (quotient > 32767 || quotient < -32768) {
      divideError(context, ip);
    }

    registers.ax = quotient & 0xffff;
    registers.dx = (numerator % divisor) & 0xffff;
    return;
  }

  const quotient = Math.floor(dividend / value);
  if (quotient > 0xffff) {
    divideError(context, ip);
  }

  registers.ax = quotient & 0xffff;
  registers.dx = (dividend % value) & 0xffff;
}

function executeString(context: X86Context, instruction: Instruction, ip: number): number {
  const { registers } = context;
  const width: ByteWidth = instruction.mnemonic.endsWith("b") ? 8 : 16;
  const step = getFlag(registers, "df") ? -width / 8 : width / 8;
  const sourceSegment = context.registers[instruction.segmentOverride ?? "ds"];
  const compared = instruction.mnemonic.startsWith("cmps") || instruction.mnemonic.startsWith("scas");
  const repeatWhileEqual = instruction.rep !== "repne";
  let iterations = 0;

  const shouldRepeat = (): boolean => {
    if (!instruction.rep) {
      return iterations === 0;
    }

    if (registers.cx === 0) {
      return false;
    }

    if (!compared) {
      return true;
    }

    const zero = getFlag(registers, "zf");
    return repeatWhileEqual ? zero : !zero;
  };

  while (shouldRepeat()) {
    switch (instruction.mnemonic) {
      case "movsb":
      case "movsw": {
        const value = readMemory(context, sourceSegment, registers.si, width);
        writeMemory(context, registers.es, registers.di, width, value);
        registers.si = (registers.si + step) & 0xffff;
        registers.di = (registers.di + step) & 0xffff;
        break;
      }
      case "stosb":
      case "stosw": {
        const value = width === 8 ? registers.ax & 0xff : registers.ax & 0xffff;
        writeMemory(context, registers.es, registers.di, width, value);
        registers.di = (registers.di + step) & 0xffff;
        break;
      }
      case "lodsb":
      case "lodsw": {
        const value = readMemory(context, sourceSegment, registers.si, width);
        if (width === 8) {
          registers.ax = (registers.ax & 0xff00) | (value & 0xff);
        } else {
          registers.ax = value & 0xffff;
        }

        registers.si = (registers.si + step) & 0xffff;
        break;
      }
      case "scasb":
      case "scasw": {
        const value = readMemory(context, registers.es, registers.di, width);
        const target = width === 8 ? registers.ax & 0xff : registers.ax & 0xffff;
        subFlags(registers, target, value, 0, width);
        registers.di = (registers.di + step) & 0xffff;
        break;
      }
      case "cmpsb":
      case "cmpsw": {
        const left = readMemory(context, sourceSegment, registers.si, width);
        const right = readMemory(context, registers.es, registers.di, width);
        subFlags(registers, left, right, 0, width);
        registers.si = (registers.si + step) & 0xffff;
        registers.di = (registers.di + step) & 0xffff;
        break;
      }
      default:
        throw new X86RuntimeError(`${instruction.mnemonic.toUpperCase()} is not a string instruction`, ip);
    }

    if (instruction.rep) {
      registers.cx = (registers.cx - 1) & 0xffff;
    }

    iterations += 1;
    if (iterations > 1_000_000) {
      throw new X86RuntimeError("a repeated string instruction did not finish", ip);
    }
  }

  return iterations;
}

function serviceInterrupt(context: X86Context, vector: number, ip: number): void {
  const { registers } = context;
  const functionCode = (registers.ax >> 8) & 0xff;

  const print = (text: string) => {
    context.output.push(text);
  };

  if (vector === 0x21) {
    switch (functionCode) {
      case 0x00:
      case 0x4c:
        context.terminated = true;
        return;
      case 0x01:
        registers.ax = (registers.ax & 0xff00) | (context.device.read(0x00) & 0xff);
        return;
      case 0x02:
        print(String.fromCharCode(registers.dx & 0xff));
        return;
      case 0x09: {
        const address = registers.dx & 0xffff;
        let text = "";
        for (let index = 0; index < 0x10000; index += 1) {
          const value = readMemory(context, registers.ds, (address + index) & 0xffff, 8);
          if (value === 0x24 || value === 0x00) {
            break;
          }

          text += String.fromCharCode(value);
        }

        print(text);
        return;
      }
      case 0x06:
      case 0x07:
        print(String.fromCharCode(registers.dx & 0xff));
        return;
      default:
        throw new X86RuntimeError(`INT 21h function ${functionCode.toString(16).toUpperCase().padStart(2, "0")}h is not emulated`, ip);
    }
  }

  if (vector === 0x20) {
    context.terminated = true;
    return;
  }

  if (vector === 0x10) {
    switch (functionCode) {
      case 0x0e:
        print(String.fromCharCode(registers.dx & 0xff));
        return;
      case 0x00:
      case 0x02:
      case 0x06:
      case 0x09:
      case 0x0a:
        return;
      default:
        throw new X86RuntimeError(`INT 10h function ${functionCode.toString(16).toUpperCase().padStart(2, "0")}h is not emulated`, ip);
    }
  }

  if (vector === 0x16) {
    if (functionCode === 0x00 || functionCode === 0x01) {
      registers.ax = (registers.ax & 0xff00) | (context.device.read(0x00) & 0xff);
      return;
    }
  }

  throw new X86RuntimeError(`interrupt ${vector.toString(16).toUpperCase().padStart(2, "0")}h is not implemented by this emulator`, ip);
}

function portValue(context: X86Context, operand: Operand, ip: number): number {
  if (operand.kind === "immediate") {
    return operand.value & 0xff;
  }

  if (operand.kind === "register" && operand.code === 2) {
    return context.registers.dx & 0xff;
  }

  throw new X86RuntimeError("the port must come from DX or an 8-bit immediate", ip);
}

export function executeInstruction(context: X86Context): ExecutedInstruction {
  const { registers } = context;
  const start = registers.ip;
  const instruction = decodeAt({ registers, memory: context.memory }, start);
  context.reads = [];
  context.writes = [];
  context.io = [];
  const nextIp = (start + instruction.length) & 0xffff;
  const [first, second] = instruction.operands;
  let repeats = 1;

  const done = (ip: number = nextIp): ExecutedInstruction => {
    registers.ip = ip & 0xffff;
    return { instruction, nextIp: registers.ip, repeats };
  };

  switch (instruction.mnemonic) {
    case "add":
    case "adc":
    case "sub":
    case "sbb":
    case "and":
    case "or":
    case "xor":
    case "cmp":
    case "test": {
      if (!first || !second) {
        throw new X86RuntimeError(`${instruction.text} is missing an operand`, start);
      }

      executeAlu(context, instruction.mnemonic, first, second, start);
      return done();
    }
    case "mov": {
      if (!first || !second) {
        throw new X86RuntimeError("MOV is missing an operand", start);
      }

      const value = readOperand(context, second);
      writeOperand(context, first, value, start);
      return done();
    }
    case "lea": {
      if (!first || !second || second.kind !== "memory") {
        throw new X86RuntimeError("LEA needs a register and a memory operand", start);
      }

      writeOperand(context, first, second.effective, start);
      return done();
    }
    case "xchg": {
      if (!first || !second) {
        throw new X86RuntimeError("XCHG is missing an operand", start);
      }

      const left = readOperand(context, first);
      const right = readOperand(context, second);
      writeOperand(context, first, right, start);
      writeOperand(context, second, left, start);
      return done();
    }
    case "inc":
    case "dec": {
      if (!first) {
        throw new X86RuntimeError(`${instruction.text} is missing an operand`, start);
      }

      const value = readOperand(context, first);
      const carry = getFlag(registers, "cf");
      const result = instruction.mnemonic === "inc"
        ? addFlags(registers, value, 1, 0, first.width)
        : subFlags(registers, value, 1, 0, first.width);
      setFlag(registers, "cf", carry);
      writeOperand(context, first, result, start);
      return done();
    }
    case "not": {
      if (!first) {
        throw new X86RuntimeError("NOT is missing an operand", start);
      }

      const value = readOperand(context, first) & mask(first.width);
      writeOperand(context, first, ~value & mask(first.width), start);
      return done();
    }
    case "neg": {
      if (!first) {
        throw new X86RuntimeError("NEG is missing an operand", start);
      }

      const value = readOperand(context, first) & mask(first.width);
      const result = subFlags(registers, 0, value, 0, first.width);
      setFlag(registers, "cf", value !== 0);
      setFlag(registers, "of", value === signBit(first.width));
      writeOperand(context, first, result, start);
      return done();
    }
    case "mul":
    case "imul":
    case "div":
    case "idiv": {
      if (!first) {
        throw new X86RuntimeError(`${instruction.text} is missing an operand`, start);
      }

      if (instruction.mnemonic === "mul" || instruction.mnemonic === "imul") {
        executeMultiply(context, instruction.mnemonic, first);
      } else {
        executeDivide(context, instruction.mnemonic, first, start);
      }

      return done();
    }
    case "rol":
    case "ror":
    case "shl":
    case "shr":
    case "sal":
    case "sar": {
      if (!first) {
        throw new X86RuntimeError(`${instruction.text} is missing an operand`, start);
      }

      const count = second?.kind === "register" ? registers.cx & 0xff : second?.kind === "immediate" ? second.value : 1;
      executeShift(context, instruction.mnemonic, first, count, start);
      return done();
    }
    case "push": {
      if (!first) {
        throw new X86RuntimeError("PUSH is missing an operand", start);
      }

      pushWord(context, readOperand(context, first));
      return done();
    }
    case "pop": {
      if (!first) {
        throw new X86RuntimeError("POP is missing an operand", start);
      }

      const value = popWord(context);
      writeOperand(context, first, value, start);
      return done();
    }
    case "call": {
      if (instruction.jumpTarget !== null) {
        pushWord(context, nextIp);
        return done(instruction.jumpTarget);
      }

      if (!first || first.kind !== "memory") {
        throw new X86RuntimeError("CALL through a register or memory operand needs an address operand", start);
      }

      const target = readOperand(context, first);
      pushWord(context, nextIp);
      return done(target);
    }
    case "ret": {
      const target = popWord(context);
      const extra = first?.kind === "immediate" ? first.value : 0;
      registers.sp = (registers.sp + extra) & 0xffff;
      return done(target);
    }
    case "jmp": {
      if (instruction.jumpTarget !== null) {
        return done(instruction.jumpTarget);
      }

      if (!first) {
        throw new X86RuntimeError("JMP is missing an operand", start);
      }

      return done(readOperand(context, first));
    }
    case "jcxz":
      return done(registers.cx === 0 ? instruction.jumpTarget ?? nextIp : nextIp);
    case "loop":
    case "loope":
    case "loopne": {
      registers.cx = (registers.cx - 1) & 0xffff;
      const zero = getFlag(registers, "zf");
      const take = instruction.mnemonic === "loop"
        ? registers.cx !== 0
        : instruction.mnemonic === "loope"
          ? registers.cx !== 0 && zero
          : registers.cx !== 0 && !zero;
      return done(take ? instruction.jumpTarget ?? nextIp : nextIp);
    }
    case "in": {
      if (!first || !second) {
        throw new X86RuntimeError("IN is missing an operand", start);
      }

      const port = portValue(context, second, start);
      const value = context.device.read(port) & mask(first.width);
      context.io.push({ port, width: first.width / 8 as 1 | 2, value, direction: "in" });
      writeOperand(context, first, value, start);
      return done();
    }
    case "out": {
      if (!first || !second) {
        throw new X86RuntimeError("OUT is missing an operand", start);
      }

      const port = portValue(context, first, start);
      const value = readOperand(context, second) & mask(second.width);
      context.io.push({ port, width: second.width / 8 as 1 | 2, value, direction: "out" });
      context.device.write(port, value);
      return done();
    }
    case "movsb":
    case "movsw":
    case "cmpsb":
    case "cmpsw":
    case "stosb":
    case "stosw":
    case "lodsb":
    case "lodsw":
    case "scasb":
    case "scasw":
      repeats = executeString(context, instruction, start);
      return done();
    case "cbw": {
      registers.ax = signedValue(registers.ax & 0xff, 8) & 0xffff;
      return done();
    }
    case "cwd": {
      registers.dx = (registers.ax & 0x8000) !== 0 ? 0xffff : 0x0000;
      return done();
    }
    case "nop":
      return done();
    case "hlt":
      context.halted = true;
      return done();
    case "clc":
      setFlag(registers, "cf", false);
      return done();
    case "stc":
      setFlag(registers, "cf", true);
      return done();
    case "cmc":
      setFlag(registers, "cf", !getFlag(registers, "cf"));
      return done();
    case "cld":
      setFlag(registers, "df", false);
      return done();
    case "std":
      setFlag(registers, "df", true);
      return done();
    case "cli":
      setFlag(registers, "if", false);
      return done();
    case "sti":
      setFlag(registers, "if", true);
      return done();
    case "int": {
      serviceInterrupt(context, instruction.interrupt ?? 0, start);
      return done();
    }
    default: {
      if (instruction.mnemonic.startsWith("j")) {
        return done(evaluateCondition(registers, instruction.mnemonic.slice(1)) ? instruction.jumpTarget ?? nextIp : nextIp);
      }

      throw new X86RuntimeError(`${instruction.text} cannot be executed by this core`, start);
    }
  }
}

export { numberToFlags, type MemoryOperand, type SegmentName };
