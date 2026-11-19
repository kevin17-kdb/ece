export const generalRegisters = ["ax", "bx", "cx", "dx", "si", "di", "bp", "sp"] as const;
export const segmentRegisters = ["es", "cs", "ss", "ds"] as const;

export type GeneralRegister = (typeof generalRegisters)[number];
export type SegmentRegister = (typeof segmentRegisters)[number];
export type RegisterName = GeneralRegister | SegmentRegister | "ip" | "flags";

export const registerEncoding: Record<GeneralRegister, number> = {
  ax: 0,
  cx: 1,
  dx: 2,
  bx: 3,
  sp: 4,
  bp: 5,
  si: 6,
  di: 7,
};

export const segmentEncoding: Record<SegmentRegister, number> = {
  es: 0,
  cs: 1,
  ss: 2,
  ds: 3,
};

export const byteRegisterLow: Record<string, GeneralRegister> = {
  al: "ax",
  cl: "cx",
  dl: "dx",
  bl: "bx",
  ah: "ax",
  ch: "cx",
  dh: "dx",
  bh: "bx",
};

export const byteRegisterHigh = new Set(["ah", "ch", "dh", "bh"]);

export const conditionCodes: Record<string, string> = {
  je: "e",
  jz: "e",
  jne: "ne",
  jnz: "ne",
  jl: "l",
  jnge: "l",
  jle: "le",
  jng: "le",
  jg: "g",
  jnle: "g",
  jge: "ge",
  jnl: "ge",
  jb: "b",
  jnae: "b",
  jc: "b",
  jbe: "be",
  jna: "be",
  ja: "a",
  jnbe: "a",
  jae: "ae",
  jnb: "ae",
  jnc: "ae",
  js: "s",
  jns: "ns",
  jo: "o",
  jno: "no",
  jp: "p",
  jpe: "p",
  jnp: "np",
  jpo: "np",
};

export const flagLabels: Array<{ key: FlagKey; name: string; description: string }> = [
  { key: "cf", name: "CF", description: "carry / borrow" },
  { key: "pf", name: "PF", description: "parity (low byte even)" },
  { key: "af", name: "AF", description: "auxiliary carry" },
  { key: "zf", name: "ZF", description: "zero" },
  { key: "sf", name: "SF", description: "sign" },
  { key: "of", name: "OF", description: "overflow" },
  { key: "df", name: "DF", description: "direction (string ops)" },
  { key: "if", name: "IF", description: "interrupt enable" },
  { key: "tf", name: "TF", description: "trap (single step)" },
];

export type FlagKey = "cf" | "pf" | "af" | "zf" | "sf" | "of" | "df" | "if" | "tf";

export type X86Flags = Record<FlagKey, boolean>;

export const flagBits: Array<[FlagKey, number]> = [
  ["cf", 0x0001],
  ["pf", 0x0004],
  ["af", 0x0010],
  ["zf", 0x0040],
  ["sf", 0x0080],
  ["tf", 0x0100],
  ["if", 0x0200],
  ["df", 0x0400],
  ["of", 0x0800],
];

export function flagsToNumber(flags: X86Flags): number {
  return flagBits.reduce((value, [key, bit]) => (flags[key] ? value | bit : value), 0);
}

export function numberToFlags(value: number): X86Flags {
  const flags: X86Flags = { cf: false, pf: false, af: false, zf: false, sf: false, of: false, df: false, if: false, tf: false };
  for (const [key, bit] of flagBits) {
    flags[key] = (value & bit) !== 0;
  }

  return flags;
}

export interface X86Registers {
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
  ss: number;
  es: number;
  ip: number;
  flags: number;
}

export function createRegisters(): X86Registers {
  return { ax: 0, bx: 0, cx: 0, dx: 0, si: 0, di: 0, bp: 0, sp: 0, cs: 0, ds: 0, ss: 0, es: 0, ip: 0, flags: 0x0202 };
}

export interface MemoryAccess {
  segment: number;
  offset: number;
  address: number;
  size: 1 | 2;
  mode: "read" | "write" | "read-write";
  value: number;
}

export interface PortAccess {
  port: number;
  width: 1 | 2;
  value: number;
  direction: "in" | "out";
}

export interface X86ListingEntry {
  line: number;
  address: number;
  bytes: number[];
  text: string;
  label?: string;
}

export interface X86Diagnostic {
  severity: "error" | "warning";
  message: string;
  line: number;
}

export interface X86SegmentDefinition {
  name: string;
  class: string;
  org: number;
}

export interface X86Assembly {
  bytes: number[];
  origin: number;
  entryPoint: number;
  codeEnd: number;
  listing: X86ListingEntry[];
  symbols: Array<{ name: string; value: number; line: number }>;
  segments: X86SegmentDefinition[];
  diagnostics: X86Diagnostic[];
}

export interface X86StepTrace {
  index: number;
  ip: number;
  segment: number;
  text: string;
  sourceLine: number | null;
  registers: X86Registers;
  reads: MemoryAccess[];
  writes: MemoryAccess[];
  io: PortAccess[];
  executed: boolean;
}

export interface X86RunResult {
  steps: number;
  trace: X86StepTrace[];
  finalRegisters: X86Registers;
  finalFlags: X86Flags;
  console: string[];
  portValues: Record<number, number>;
  accesses: MemoryAccess[];
  haltReason: "terminated" | "halted" | "step-limit" | "error";
  error?: { message: string; line: number | null; ip: number };
  elapsedMs: number;
}
