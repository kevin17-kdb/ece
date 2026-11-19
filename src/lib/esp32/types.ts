export interface Esp32Diagnostic {
  severity: "error" | "warning";
  message: string;
  line: number;
}

export interface Esp32ListingEntry {
  line: number;
  address: number;
  bytes: number[];
  text: string;
  label?: string;
}

export interface Esp32Symbol {
  name: string;
  value: number;
  line: number;
}

export interface Esp32Assembly {
  bytes: number[];
  origin: number;
  entryPoint: number;
  codeEnd: number;
  listing: Esp32ListingEntry[];
  symbols: Esp32Symbol[];
  diagnostics: Esp32Diagnostic[];
}

export interface Esp32State {
  pc: number;
  registers: Int32Array;
  memory: Uint8Array;
  gpioOut: number;
  gpioIn: number;
  console: string[];
  halted: boolean;
  exitCode: number | null;
  cycles: number;
}

export interface Esp32Step {
  index: number;
  pc: number;
  text: string;
  sourceLine: number | null;
  a0: number;
  sp: number;
  gpio: number;
  consoleLength: number;
}

export interface Esp32RunResult {
  steps: number;
  halted: boolean;
  haltReason: "halted" | "terminated" | "step-limit" | "error";
  error?: string;
  line: number | null;
  console: string[];
  trace: Esp32Step[];
  finalState: Esp32State;
  elapsedMs: number;
}

/**
 * Simplified memory-mapped I/O model for the ESP32-C3 GPIO/UART subset.
 * Addressing follows the ESP32-C3 peripheral window (0x6000_00xx) so programs
 * look realistic, but only the registers below are modelled.
 */
export const esp32Mmu = {
  gpioBase: 0x60004000,
  gpioOut: 0x60004004,
  gpioIn: 0x6000403c,
  uartTx: 0x60000000,
} as const;

export const esp32MemorySize = 0x10000;

export const esp32RegisterNames: Record<string, number> = {
  zero: 0,
  ra: 1,
  sp: 2,
  gp: 3,
  tp: 4,
  t0: 5,
  t1: 6,
  t2: 7,
  s0: 8,
  fp: 8,
  s1: 9,
  a0: 10,
  a1: 11,
  a2: 12,
  a3: 13,
  a4: 14,
  a5: 15,
  a6: 16,
  a7: 17,
  s2: 18,
  s3: 19,
  s4: 20,
  s5: 21,
  s6: 22,
  s7: 23,
  s8: 24,
  s9: 25,
  s10: 26,
  s11: 27,
  t3: 28,
  t4: 29,
  t5: 30,
  t6: 31,
};

for (let index = 0; index < 32; index += 1) {
  esp32RegisterNames[`x${index}`] = index;
}

export const esp32AbiNames = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
  "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7",
  "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6",
] as const;
