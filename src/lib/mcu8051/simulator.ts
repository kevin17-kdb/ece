import { assemble } from "./assembler";
import {
  sfrAddress,
  type X8051Assembly,
  type X8051ListingEntry,
  type X8051RunResult,
  type X8051State,
  type X8051Step,
} from "./types";

export const defaultStepLimit = 20000;

const ACC = sfrAddress.acc - 0x80;
const B_REG = sfrAddress.b - 0x80;
const PSW = sfrAddress.psw - 0x80;
const SP = sfrAddress.sp - 0x80;
const DPL = sfrAddress.dpl - 0x80;
const DPH = sfrAddress.dph - 0x80;
const SBUF = sfrAddress.sbuf - 0x80;

const CY = 0x80;
const AC = 0x40;
const OV = 0x04;

export function createState(): X8051State {
  const sfr = new Uint8Array(128);
  sfr[SP] = 0x07;
  sfr[sfrAddress.p0 - 0x80] = 0xff;
  sfr[sfrAddress.p1 - 0x80] = 0xff;
  sfr[sfrAddress.p2 - 0x80] = 0xff;
  sfr[sfrAddress.p3 - 0x80] = 0xff;
  return { pc: 0, iram: new Uint8Array(256), sfr, xram: new Uint8Array(0x10000), console: [], halted: false, cycles: 0 };
}

function parity(value: number): number {
  let bits = value & 0xff;
  let count = 0;
  while (bits > 0) {
    count += bits & 1;
    bits >>= 1;
  }

  return count % 2;
}

function signed(value: number): number {
  return value < 0x80 ? value : value - 0x100;
}

/**
 * Executes exactly one instructions worth of work against the machine state,
 * advancing the program counter. Throws on an unsupported opcode.
 */
export function executeInstruction(state: X8051State, code: Uint8Array, listing: Map<number, X8051ListingEntry>): void {
  const origin = state.pc;
  const fetch = (): number => {
    const byte = code[state.pc] ?? 0;
    state.pc = (state.pc + 1) & 0xffff;
    return byte & 0xff;
  };
  const a = (): number => state.sfr[ACC];
  const setA = (value: number): void => {
    state.sfr[ACC] = value & 0xff;
    state.sfr[PSW] = (state.sfr[PSW] & 0xfe) | parity(value);
  };
  const setFlag = (mask: number, on: boolean): void => {
    state.sfr[PSW] = on ? state.sfr[PSW] | mask : state.sfr[PSW] & ~mask;
  };
  const flag = (mask: number): boolean => (state.sfr[PSW] & mask) !== 0;
  const dptr = (): number => ((state.sfr[DPH] << 8) | state.sfr[DPL]) & 0xffff;
  const setDptr = (value: number): void => {
    state.sfr[DPH] = (value >> 8) & 0xff;
    state.sfr[DPL] = value & 0xff;
  };
  const rn = (index: number): number => state.iram[index] ?? 0;
  const setRn = (index: number, value: number): void => {
    state.iram[index] = value & 0xff;
  };
  const readDirect = (address: number): number => (address < 0x80 ? state.iram[address] : state.sfr[address - 0x80]);
  const writeDirect = (address: number, value: number): void => {
    if (address === sfrAddress.sbuf) {
      state.sfr[SBUF] = value & 0xff;
      state.console.push(String.fromCharCode(value & 0xff));
      return;
    }

    if (address < 0x80) {
      state.iram[address] = value & 0xff;
    } else {
      state.sfr[address - 0x80] = value & 0xff;
    }
  };
  const readIndirect = (i: number): number => {
    const address = state.iram[i];
    return address < 0x80 ? state.iram[address] : state.sfr[address - 0x80];
  };
  const writeIndirect = (i: number, value: number): void => {
    const address = state.iram[i];
    if (address < 0x80) {
      state.iram[address] = value & 0xff;
    } else {
      state.sfr[address - 0x80] = value & 0xff;
    }
  };
  const readBit = (bit: number): number => (bit < 0x80 ? (state.iram[0x20 + (bit >> 3)] >> (bit & 7)) & 1 : (state.sfr[(bit & 0xf8) - 0x80] >> (bit & 7)) & 1);
  const writeBit = (bit: number, value: number): void => {
    if (bit < 0x80) {
      const byte = 0x20 + (bit >> 3);
      const mask = 1 << (bit & 7);
      state.iram[byte] = value ? state.iram[byte] | mask : state.iram[byte] & ~mask;
      return;
    }

    const offset = (bit & 0xf8) - 0x80;
    const mask = 1 << (bit & 7);
    state.sfr[offset] = value ? state.sfr[offset] | mask : state.sfr[offset] & ~mask;
  };
  const operandValue = (op: number): number => {
    if (opcode === 0x24 || opcode === 0x34 || opcode === 0x94) {
      return fetch();
    }
    if ((opcode & 0x0f) < 0x08 && (opcode & 0x06) === 0x04) {
      return readDirect(fetch());
    }

    if (opcode === 0x26 || opcode === 0x27 || opcode === 0x36 || opcode === 0x37 || opcode === 0x96 || opcode === 0x97) {
      return readIndirect(opcode & 1);
    }

    void op;
    return rn(opcode & 7);
  };

  const opcode = fetch();

  const add = (value: number, carry: number): void => {
    const acc = a();
    const sum = a() + value + carry;
    const result = sum & 0xff;
    setFlag(CY, sum > 0xff);
    setFlag(AC, ((acc & 0x0f) + (value & 0x0f) + carry) > 0x0f);
    setFlag(OV, ((acc ^ (result & 0xff)) & (value ^ result) & 0x80) !== 0);
    setA(result);
  };
  const subtract = (value: number, borrow: number): void => {
    const acc = a();
    const diff = acc - value - borrow;
    const result = diff & 0xff;
    setFlag(CY, diff < 0);
    setFlag(AC, (acc & 0x0f) - (value & 0x0f) - borrow < 0);
    setFlag(OV, ((acc ^ value) & (acc ^ result) & 0x80) !== 0);
    setA(result);
  };

  if (opcode === 0x00) {
    return;
  }

  if (opcode === 0x74) {
    setA(fetch());
    return;
  }

  if (opcode === 0xe5) {
    setA(readDirect(fetch()));
    return;
  }

  if (opcode === 0xe6 || opcode === 0xe7) {
    setA(readIndirect(opcode & 1));
    return;
  }

  if (opcode >= 0xe8 && opcode <= 0xef) {
    setA(rn(opcode & 7));
    return;
  }

  if (opcode === 0xf5) {
    writeDirect(fetch(), a());
    return;
  }

  if (opcode === 0xf6 || opcode === 0xf7) {
    writeIndirect(opcode & 1, a());
    return;
  }

  if (opcode >= 0xf8 && opcode <= 0xff) {
    setRn(opcode & 7, a());
    return;
  }

  if (opcode >= 0x78 && opcode <= 0x7f) {
    setRn(opcode & 7, fetch());
    return;
  }

  if (opcode === 0x75) {
    const direct = fetch();
    writeDirect(direct, fetch());
    return;
  }

  if (opcode === 0x85) {
    const source = fetch();
    const destination = fetch();
    writeDirect(destination, readDirect(source));
    return;
  }

  if (opcode === 0x86 || opcode === 0x87) {
    writeDirect(fetch(), readIndirect(opcode & 1));
    return;
  }

  if (opcode >= 0x88 && opcode <= 0x8f) {
    writeDirect(fetch(), rn(opcode & 7));
    return;
  }

  if (opcode === 0xa6 || opcode === 0xa7) {
    writeIndirect(opcode & 1, readDirect(fetch()));
    return;
  }

  if (opcode >= 0xa8 && opcode <= 0xaf) {
    setRn(opcode & 7, readDirect(fetch()));
    return;
  }

  if (opcode === 0x90) {
    const high = fetch();
    const low = fetch();
    setDptr((high << 8) | low);
    return;
  }

  if (opcode === 0x93) {
    setA(code[(dptr() + a()) & 0xffff] ?? 0);
    return;
  }

  if (opcode === 0x83) {
    setA(code[(state.pc + a()) & 0xffff] ?? 0);
    return;
  }

  if (opcode === 0xe0) {
    setA(state.xram[dptr()] ?? 0);
    return;
  }

  if (opcode === 0xf0) {
    state.xram[dptr()] = a();
    return;
  }

  if (opcode === 0xe2 || opcode === 0xe3) {
    setA(state.xram[state.iram[opcode & 1]] ?? 0);
    return;
  }

  if (opcode === 0xf2 || opcode === 0xf3) {
    state.xram[state.iram[opcode & 1]] = a();
    return;
  }

  if (opcode >= 0x24 && opcode <= 0x2f) {
    add(operandValue(opcode), 0);
    return;
  }

  if (opcode >= 0x34 && opcode <= 0x3f) {
    add(operandValue(opcode), flag(CY) ? 1 : 0);
    return;
  }

  if (opcode >= 0x94 && opcode <= 0x9f) {
    subtract(operandValue(opcode), 0);
    return;
  }

  if (opcode === 0xa4) {
    const product = a() * state.sfr[B_REG];
    setFlag(CY, false);
    setA(product & 0xff);
    state.sfr[B_REG] = (product >> 8) & 0xff;
    setFlag(OV, product > 0xff);
    return;
  }

  if (opcode === 0x84) {
    setFlag(CY, false);
    if (state.sfr[B_REG] === 0) {
      setFlag(OV, true);
      return;
    }

    const dividend = a();
    const divisor = state.sfr[B_REG];
    setA(Math.floor(dividend / divisor));
    state.sfr[B_REG] = dividend % divisor;
    setFlag(OV, false);
    return;
  }

  if (opcode === 0x04) {
    setA(a() + 1);
    return;
  }
  if (opcode === 0x05) {
    const direct = fetch();
    writeDirect(direct, readDirect(direct) + 1);
    return;
  }
  if (opcode === 0x06 || opcode === 0x07) {
    writeIndirect(opcode & 1, readIndirect(opcode & 1) + 1);
    return;
  }
  if (opcode >= 0x08 && opcode <= 0x0f) {
    setRn(opcode & 7, rn(opcode & 7) + 1);
    return;
  }
  if (opcode === 0xa3) {
    setDptr(dptr() + 1);
    return;
  }

  if (opcode === 0x14) {
    setA(a() - 1);
    return;
  }
  if (opcode === 0x15) {
    const direct = fetch();
    writeDirect(direct, readDirect(direct) - 1);
    return;
  }
  if (opcode === 0x16 || opcode === 0x17) {
    writeIndirect(opcode & 1, readIndirect(opcode & 1) - 1);
    return;
  }
  if (opcode >= 0x18 && opcode <= 0x1f) {
    setRn(opcode & 7, rn(opcode & 7) - 1);
    return;
  }

  if (opcode === 0x53) {
    const direct = fetch();
    writeDirect(direct, readDirect(direct) & fetch());
    return;
  }
  if (opcode === 0x52) {
    const direct = fetch();
    writeDirect(direct, readDirect(direct) & a());
    return;
  }
  if (opcode === 0x43) {
    const direct = fetch();
    writeDirect(direct, readDirect(direct) | fetch());
    return;
  }
  if (opcode === 0x42) {
    const direct = fetch();
    writeDirect(direct, readDirect(direct) | a());
    return;
  }
  if (opcode === 0x63) {
    const direct = fetch();
    writeDirect(direct, readDirect(direct) ^ fetch());
    return;
  }
  if (opcode === 0x62) {
    const direct = fetch();
    writeDirect(direct, readDirect(direct) ^ a());
    return;
  }

  const logicalOperation = opcode >> 4;
  if (opcode >= 0x44 && opcode <= 0x6f && (logicalOperation === 4 || logicalOperation === 5 || logicalOperation === 6)) {
    const low = opcode & 0x0f;
    let value: number;
    if (low === 4) {
      value = fetch();
    } else if (low === 5) {
      value = readDirect(fetch());
    } else if (low === 6 || low === 7) {
      value = readIndirect(opcode & 1);
    } else {
      value = rn(opcode & 7);
    }

    const result = logicalOperation === 5 ? a() & value : logicalOperation === 4 ? a() | value : a() ^ value;
    setA(result);
    return;
  }

  if (opcode === 0xe4) {
    setA(0);
    return;
  }
  if (opcode === 0xf4) {
    setA(~a() & 0xff);
    return;
  }

  if (opcode === 0x03) {
    setA((a() >> 1) | ((a() & 1) << 7));
    return;
  }
  if (opcode === 0x23) {
    const carry = flag(CY) ? 1 : 0;
    setFlag(CY, (a() & 0x80) !== 0);
    setA(((a() << 1) | carry) & 0xff);
    return;
  }
  if (opcode === 0x13) {
    const carry = flag(CY) ? 0x80 : 0;
    setFlag(CY, (a() & 1) !== 0);
    setA((a() >> 1) | carry);
    return;
  }
  if (opcode === 0x33) {
    const carry = flag(CY) ? 1 : 0;
    setFlag(CY, (a() & 0x80) !== 0);
    setA(((a() << 1) | carry) & 0xff);
    return;
  }
  if (opcode === 0xc4) {
    setA(((a() << 4) | (a() >> 4)) & 0xff);
    return;
  }

  if (opcode === 0xc3) {
    setFlag(CY, false);
    return;
  }
  if (opcode === 0xd3) {
    setFlag(CY, true);
    return;
  }
  if (opcode === 0xb3) {
    setFlag(CY, !flag(CY));
    return;
  }
  if (opcode === 0xc2) {
    writeBit(fetch(), 0);
    return;
  }
  if (opcode === 0xd2) {
    writeBit(fetch(), 1);
    return;
  }
  if (opcode === 0xb2) {
    const bit = fetch();
    writeBit(bit, readBit(bit) ^ 1);
    return;
  }
  if (opcode === 0xa2) {
    setFlag(CY, readBit(fetch()) === 1);
    return;
  }
  if (opcode === 0x92) {
    writeBit(fetch(), flag(CY) ? 1 : 0);
    return;
  }

  if (opcode === 0x02 || opcode === 0x12) {
    const high = fetch();
    const low = fetch();
    const target = ((high << 8) | low) & 0xffff;
    if (opcode === 0x12) {
      pushByte(state, state.pc & 0xff);
      pushByte(state, (state.pc >> 8) & 0xff);
    } else if (target === origin) {
      state.halted = true;
    }

    state.pc = target;
    return;
  }

  if (opcode === 0x22 || opcode === 0x32) {
    const high = popByte(state);
    const low = popByte(state);
    state.pc = ((high << 8) | low) & 0xffff;
    return;
  }

  if (opcode === 0x80) {
    const rel = fetch();
    const target = (state.pc + signed(rel)) & 0xffff;
    if (target === origin) {
      state.halted = true;
    }

    state.pc = target;
    return;
  }

  if (opcode === 0x60 || opcode === 0x70 || opcode === 0x40 || opcode === 0x50) {
    const rel = fetch();
    const take = opcode === 0x60 ? a() === 0 : opcode === 0x70 ? a() !== 0 : opcode === 0x40 ? flag(CY) : !flag(CY);
    if (take) {
      state.pc = (state.pc + signed(rel)) & 0xffff;
    }
    return;
  }

  if (opcode === 0x20 || opcode === 0x30 || opcode === 0x10) {
    const bit = fetch();
    const rel = fetch();
    const value = readBit(bit) === 1;
    if (opcode === 0x10 && value) {
      writeBit(bit, 0);
    }
    const take = opcode === 0x20 ? value : opcode === 0x30 ? !value : value;
    if (take) {
      state.pc = (state.pc + signed(rel)) & 0xffff;
    }
    return;
  }

  if (opcode === 0xb4 || opcode === 0xb5 || opcode === 0xb6 || opcode === 0xb7 || (opcode >= 0xb8 && opcode <= 0xbf)) {
    let left: number;
    let right: number;
    if (opcode === 0xb4) {
      right = fetch();
      left = a();
    } else if (opcode === 0xb5) {
      right = readDirect(fetch());
      left = a();
    } else if (opcode === 0xb6 || opcode === 0xb7) {
      right = fetch();
      left = readIndirect(opcode & 1);
    } else {
      right = fetch();
      left = rn(opcode & 7);
    }

    const rel = fetch();
    setFlag(CY, left < right);
    if (left !== right) {
      state.pc = (state.pc + signed(rel)) & 0xffff;
    }
    return;
  }

  if ((opcode >= 0xd8 && opcode <= 0xdf) || opcode === 0xd5) {
    if (opcode === 0xd5) {
      const direct = fetch();
      const rel = fetch();
      const value = (readDirect(direct) - 1) & 0xff;
      writeDirect(direct, value);
      if (value !== 0) {
        state.pc = (state.pc + signed(rel)) & 0xffff;
      }
    } else {
      const index = opcode & 7;
      const rel = fetch();
      const value = (rn(index) - 1) & 0xff;
      setRn(index, value);
      if (value !== 0) {
        state.pc = (state.pc + signed(rel)) & 0xffff;
      }
    }
    return;
  }

  if (opcode === 0xc0) {
    pushByte(state, readDirect(fetch()));
    return;
  }

  if (opcode === 0xd0) {
    const direct = fetch();
    writeDirect(direct, popByte(state));
    return;
  }

  if (opcode === 0x73) {
    state.pc = (a() + dptr()) & 0xffff;
    return;
  }

  void listing;
  throw new Error(
    `Unsupported opcode ${opcode.toString(16).toUpperCase().padStart(2, "0")}h at ${origin.toString(16).toUpperCase().padStart(4, "0")}h`,
  );
}

function pushByte(state: X8051State, value: number): void {
  const sp = (state.sfr[SP] + 1) & 0xff;
  state.sfr[SP] = sp;
  state.iram[sp] = value & 0xff;
}

function popByte(state: X8051State): number {
  const sp = state.sfr[SP];
  const value = state.iram[sp] ?? 0;
  state.sfr[SP] = (sp - 1) & 0xff;
  return value;
}

export function createCodeMemory(assembly: X8051Assembly): Uint8Array {
  const code = new Uint8Array(0x10000);
  for (let index = 0; index < assembly.bytes.length; index += 1) {
    code[index] = assembly.bytes[index] & 0xff;
  }

  return code;
}

export function listingByAddress(assembly: X8051Assembly): Map<number, X8051ListingEntry> {
  return new Map(assembly.listing.map((entry) => [entry.address, entry]));
}

export interface X8051Machine {
  state: X8051State;
  code: Uint8Array;
  listing: Map<number, X8051ListingEntry>;
  codeEnd: number;
}

export function createMachine(assembly: X8051Assembly): X8051Machine {
  return {
    state: createState(),
    code: createCodeMemory(assembly),
    listing: listingByAddress(assembly),
    codeEnd: assembly.codeEnd,
  };
}

export function stepMachine(machine: X8051Machine, index: number): X8051Step {
  const origin = machine.state.pc;
  executeInstruction(machine.state, machine.code, machine.listing);
  machine.state.cycles += 1;
  const entry = machine.listing.get(origin);
  return {
    index,
    pc: origin,
    text: entry?.text ?? "",
    sourceLine: entry?.line ?? null,
    a: machine.state.sfr[ACC],
    b: machine.state.sfr[B_REG],
    psw: machine.state.sfr[PSW],
    sp: machine.state.sfr[SP],
    dptr: (machine.state.sfr[DPH] << 8) | machine.state.sfr[DPL],
    ports: [machine.state.sfr[sfrAddress.p0 - 0x80], machine.state.sfr[sfrAddress.p1 - 0x80], machine.state.sfr[sfrAddress.p2 - 0x80], machine.state.sfr[sfrAddress.p3 - 0x80]],
  };
}

export interface X8051RunOptions {
  stepLimit?: number;
  traceLimit?: number;
}

export function runMachine(machine: X8051Machine, options: X8051RunOptions = {}): X8051RunResult {
  const stepLimit = options.stepLimit ?? defaultStepLimit;
  const traceLimit = options.traceLimit ?? 500;
  const start = Date.now();
  const trace: X8051Step[] = [];
  let steps = 0;

  while (steps < stepLimit) {
    const pcBefore = machine.state.pc;
    if (pcBefore > machine.codeEnd) {
      machine.state.halted = true;
      break;
    }

    try {
      const step = stepMachine(machine, steps);
      if (trace.length < traceLimit) {
        trace.push(step);
      }
    } catch (error) {
      return {
        steps,
        halted: true,
        haltReason: "error",
        error: error instanceof Error ? error.message : String(error),
        line: machine.listing.get(pcBefore)?.line ?? null,
        console: [...machine.state.console],
        trace,
        finalState: machine.state,
        elapsedMs: Date.now() - start,
      };
    }

    steps += 1;
    if (machine.state.halted) {
      break;
    }
  }

  return {
    steps,
    halted: true,
    haltReason: machine.state.halted ? "halted" : "step-limit",
    line: null,
    console: [...machine.state.console],
    trace,
    finalState: machine.state,
    elapsedMs: Date.now() - start,
  };
}

export function runX8051(source: string, options: X8051RunOptions = {}): X8051RunResult {
  const machine = createMachine(assemble(source));
  return runMachine(machine, options);
}
