import {
  esp32MemorySize,
  esp32Mmu,
  type Esp32Assembly,
  type Esp32RunResult,
  type Esp32State,
  type Esp32Step,
} from "./types";

export interface Esp32Machine {
  state: Esp32State;
  disasm: Map<number, { text: string; line: number }>;
  codeEnd: number;
}

export class Esp32RuntimeError extends Error {}

function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

export function createState(): Esp32State {
  const registers = new Int32Array(32);
  registers[2] = esp32MemorySize;
  return {
    pc: 0,
    registers,
    memory: new Uint8Array(esp32MemorySize),
    gpioOut: 0,
    gpioIn: 0xff,
    console: [],
    halted: false,
    exitCode: null,
    cycles: 0,
  };
}

export function createMachine(assembly: Esp32Assembly): Esp32Machine {
  const state = createState();
  assembly.bytes.forEach((byte, index) => {
    const address = assembly.origin + index;
    if (address < esp32MemorySize) {
      state.memory[address] = byte & 0xff;
    }
  });

  state.pc = assembly.entryPoint;

  const disasm = new Map<number, { text: string; line: number }>();
  assembly.listing.forEach((entry) => {
    disasm.set(entry.address, { text: entry.text, line: entry.line });
  });

  return { state, disasm, codeEnd: assembly.codeEnd };
}

function readByte(machine: Esp32Machine, address: number): number {
  if (address === esp32Mmu.gpioIn) {
    return machine.state.gpioIn & 0xff;
  }

  if (address === esp32Mmu.gpioOut) {
    return machine.state.gpioOut & 0xff;
  }

  if (address < 0 || address >= esp32MemorySize) {
    throw new Esp32RuntimeError(`Load from unmapped address 0x${(address >>> 0).toString(16)}.`);
  }

  return machine.state.memory[address];
}

function writeByte(machine: Esp32Machine, address: number, value: number): void {
  const byte = value & 0xff;
  if (address >= esp32Mmu.gpioOut && address < esp32Mmu.gpioOut + 4) {
    const shift = (address - esp32Mmu.gpioOut) * 8;
    machine.state.gpioOut = (machine.state.gpioOut & ~(0xff << shift)) | (byte << shift);
    return;
  }

  if (address === esp32Mmu.uartTx) {
    machine.state.console.push(String.fromCharCode(byte));
    return;
  }

  if (address < 0 || address >= esp32MemorySize) {
    throw new Esp32RuntimeError(`Store to unmapped address 0x${(address >>> 0).toString(16)}.`);
  }

  machine.state.memory[address] = byte;
}

function loadValue(machine: Esp32Machine, address: number, size: number, signed: boolean): number {
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    value |= readByte(machine, address + index) << (index * 8);
  }

  if (signed && size < 4) {
    value = signExtend(value, size * 8);
  }

  return value | 0;
}

function storeValue(machine: Esp32Machine, address: number, value: number, size: number): void {
  for (let index = 0; index < size; index += 1) {
    writeByte(machine, address + index, (value >> (index * 8)) & 0xff);
  }
}

function fetchWord(machine: Esp32Machine, address: number): number {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    const byte = address + index < esp32MemorySize ? machine.state.memory[address + index] : 0;
    value |= byte << (index * 8);
  }

  return value >>> 0;
}

export function stepMachine(machine: Esp32Machine, index: number): Esp32Step {
  const { state } = machine;
  const pc = state.pc;

  if (pc >= machine.codeEnd) {
    state.halted = true;
    state.exitCode = 0;
    return {
      index,
      pc,
      text: "— end of program —",
      sourceLine: null,
      a0: state.registers[10],
      sp: state.registers[2],
      gpio: state.gpioOut & 0xff,
      consoleLength: state.console.length,
    };
  }

  const word = fetchWord(machine, pc);
  const opcode = word & 0x7f;
  const rd = (word >> 7) & 0x1f;
  const funct3 = (word >> 12) & 0x7;
  const rs1 = (word >> 15) & 0x1f;
  const rs2 = (word >> 20) & 0x1f;
  const funct7 = (word >> 25) & 0x7f;
  const regs = state.registers;
  let nextPc = pc + 4;

  switch (opcode) {
    case 0x33: {
      const a = regs[rs1];
      const b = regs[rs2];
      let result: number;
      switch (funct3) {
        case 0x0:
          result = funct7 === 0x20 ? (a - b) | 0 : (a + b) | 0;
          break;
        case 0x7:
          result = a & b;
          break;
        case 0x6:
          result = a | b;
          break;
        case 0x4:
          result = a ^ b;
          break;
        default:
          throw new Esp32RuntimeError(`Unsupported R-type function 0x${funct3.toString(16)}.`);
      }
      if (rd !== 0) {
        regs[rd] = result;
      }
      break;
    }
    case 0x13: {
      const imm = signExtend(word >>> 20, 12);
      let result: number;
      switch (funct3) {
        case 0x0:
          result = (regs[rs1] + imm) | 0;
          break;
        case 0x1:
          result = regs[rs1] << (imm & 0x1f);
          break;
        case 0x5:
          result = regs[rs1] >>> (imm & 0x1f);
          break;
        default:
          throw new Esp32RuntimeError(`Unsupported I-type function 0x${funct3.toString(16)}.`);
      }
      if (rd !== 0) {
        regs[rd] = result;
      }
      break;
    }
    case 0x03: {
      const imm = signExtend(word >>> 20, 12);
      const address = (regs[rs1] + imm) | 0;
      const sizes: Record<number, { size: number; signed: boolean }> = {
        0x0: { size: 1, signed: true },
        0x2: { size: 4, signed: true },
        0x4: { size: 1, signed: false },
      };
      const info = sizes[funct3];
      if (!info) {
        throw new Esp32RuntimeError(`Unsupported load function 0x${funct3.toString(16)}.`);
      }
      const value = loadValue(machine, address, info.size, info.signed);
      if (rd !== 0) {
        regs[rd] = value;
      }
      break;
    }
    case 0x23: {
      const imm = signExtend(((word >>> 25) << 5) | ((word >>> 7) & 0x1f), 12);
      const address = (regs[rs1] + imm) | 0;
      const size = funct3 === 0x0 ? 1 : funct3 === 0x2 ? 4 : 0;
      if (size === 0) {
        throw new Esp32RuntimeError(`Unsupported store function 0x${funct3.toString(16)}.`);
      }
      storeValue(machine, address, regs[rs2], size);
      break;
    }
    case 0x63: {
      const imm = signExtend(((word >>> 31) << 12) | (((word >>> 7) & 1) << 11) | (((word >>> 25) & 0x3f) << 5) | (((word >>> 8) & 0xf) << 1), 13);
      const a = regs[rs1];
      const b = regs[rs2];
      const take = funct3 === 0x0 ? a === b
        : funct3 === 0x1 ? a !== b
          : funct3 === 0x4 ? a < b
            : funct3 === 0x5 ? a >= b
              : false;
      if (take) {
        nextPc = (pc + imm) | 0;
      }
      break;
    }
    case 0x6f: {
      const imm = signExtend(((word >>> 31) << 20) | (((word >>> 12) & 0xff) << 12) | (((word >>> 20) & 1) << 11) | (((word >>> 21) & 0x3ff) << 1), 21);
      if (rd !== 0) {
        regs[rd] = nextPc;
      }
      nextPc = (pc + imm) | 0;
      break;
    }
    case 0x67: {
      const imm = signExtend(word >>> 20, 12);
      const target = (regs[rs1] + imm) & ~1;
      if (rd !== 0) {
        regs[rd] = nextPc;
      }
      nextPc = target;
      break;
    }
    case 0x37: {
      if (rd !== 0) {
        regs[rd] = word & 0xfffff000;
      }
      break;
    }
    case 0x73: {
      state.halted = true;
      if (funct3 === 0x1) {
        state.exitCode = regs[10];
      } else {
        state.exitCode = 0;
      }
      break;
    }
    default:
      throw new Esp32RuntimeError(`Unsupported opcode 0x${opcode.toString(16)} at 0x${(pc >>> 0).toString(16)}.`);
  }

  regs[0] = 0;
  state.pc = nextPc;
  state.cycles += 1;

  const source = machine.disasm.get(pc);
  return {
    index,
    pc,
    text: source?.text ?? `0x${word.toString(16)}`,
    sourceLine: source?.line ?? null,
    a0: state.registers[10],
    sp: state.registers[2],
    gpio: state.gpioOut & 0xff,
    consoleLength: state.console.length,
  };
}

export interface Esp32RunOptions {
  stepLimit?: number;
}

export function runMachine(machine: Esp32Machine, options: Esp32RunOptions = {}): Esp32RunResult {
  const stepLimit = options.stepLimit ?? 100000;
  const start = Date.now();
  const trace: Esp32Step[] = [];
  let steps = 0;
  let haltReason: Esp32RunResult["haltReason"] = "step-limit";
  let error: string | undefined;

  while (steps < stepLimit) {
    try {
      const step = stepMachine(machine, steps);
      trace.push(step);
      steps += 1;
      if (machine.state.halted) {
        haltReason = machine.state.exitCode === 0 ? "halted" : "terminated";
        break;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      haltReason = "error";
      break;
    }
  }

  return {
    steps,
    halted: machine.state.halted,
    haltReason,
    error,
    line: trace.length > 0 ? trace[trace.length - 1].sourceLine : null,
    console: [...machine.state.console],
    trace,
    finalState: machine.state,
    elapsedMs: Date.now() - start,
  };
}
