export interface X8051Diagnostic {
  severity: "error" | "warning";
  message: string;
  line: number;
}

export interface X8051ListingEntry {
  line: number;
  address: number;
  bytes: number[];
  text: string;
  symbol?: string;
}

export interface X8051Symbol {
  name: string;
  value: number;
  line: number;
}

export interface X8051Assembly {
  bytes: number[];
  origin: number;
  entryPoint: number;
  codeEnd: number;
  listing: X8051ListingEntry[];
  symbols: X8051Symbol[];
  diagnostics: X8051Diagnostic[];
}

export interface X8051State {
  pc: number;
  iram: Uint8Array;
  sfr: Uint8Array;
  xram: Uint8Array;
  console: string[];
  halted: boolean;
  cycles: number;
}

export interface X8051Step {
  index: number;
  pc: number;
  text: string;
  sourceLine: number | null;
  a: number;
  b: number;
  psw: number;
  sp: number;
  dptr: number;
  ports: [number, number, number, number];
}

export interface X8051RunResult {
  steps: number;
  halted: boolean;
  haltReason: "halted" | "terminated" | "step-limit" | "error";
  error?: string;
  line: number | null;
  console: string[];
  trace: X8051Step[];
  finalState: X8051State;
  elapsedMs: number;
}

export const sfrAddress = {
  p0: 0x80,
  sp: 0x81,
  dpl: 0x82,
  dph: 0x83,
  pcon: 0x87,
  tcon: 0x88,
  tmod: 0x89,
  tl0: 0x8a,
  tl1: 0x8b,
  th0: 0x8c,
  th1: 0x8d,
  p1: 0x90,
  scon: 0x98,
  sbuf: 0x99,
  p2: 0xa0,
  ie: 0xa8,
  p3: 0xb0,
  ip: 0xb8,
  psw: 0xd0,
  acc: 0xe0,
  b: 0xf0,
} as const;

export const sfrNames: Record<string, number> = {
  P0: sfrAddress.p0,
  SP: sfrAddress.sp,
  DPL: sfrAddress.dpl,
  DPH: sfrAddress.dph,
  PCON: sfrAddress.pcon,
  TCON: sfrAddress.tcon,
  TMOD: sfrAddress.tmod,
  TL0: sfrAddress.tl0,
  TL1: sfrAddress.tl1,
  TH0: sfrAddress.th0,
  TH1: sfrAddress.th1,
  P1: sfrAddress.p1,
  SCON: sfrAddress.scon,
  SBUF: sfrAddress.sbuf,
  P2: sfrAddress.p2,
  IE: sfrAddress.ie,
  P3: sfrAddress.p3,
  IP: sfrAddress.ip,
  PSW: sfrAddress.psw,
  ACC: sfrAddress.acc,
  B: sfrAddress.b,
};

export const portNames = ["P0", "P1", "P2", "P3"] as const;
export const portAddresses = [sfrAddress.p0, sfrAddress.p1, sfrAddress.p2, sfrAddress.p3] as const;
