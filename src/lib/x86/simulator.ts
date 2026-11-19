import { assemble } from "./assembler";
import {
  createContext,
  executeInstruction,
  X86RuntimeError,
  type X86Context,
  type X86Device,
} from "./cpu";
import { X86DecodeError } from "./decoder";
import {
  flagBits,
  numberToFlags,
  type FlagKey,
  type MemoryAccess,
  type X86ListingEntry,
  type X86RunResult,
  type X86StepTrace,
} from "./types";
import { flagLabels } from "./types";

export const memorySize = 0x100000;

export const defaultStepLimit = 20000;

export function createMemory(): Uint8Array {
  return new Uint8Array(memorySize);
}

export function createNullDevice(): X86Device {
  return {
    read: () => 0,
    write: () => undefined,
  };
}

export interface X86SimulationRequest {
  source: string;
  device?: X86Device;
  maxSteps?: number;
}

export interface X86RunRequest extends X86SimulationRequest {
  listing?: X86ListingEntry[];
}

function lineForAddress(listing: X86ListingEntry[], address: number): number | null {
  let found: number | null = null;
  for (const entry of listing) {
    if (entry.address <= address && entry.bytes.length > 0) {
      found = entry.line;
    }

    if (entry.address > address) {
      break;
    }
  }

  return found;
}

function imageSourceLine(listing: X86ListingEntry[], address: number): number | null {
  const entry = listing.find((item) => item.address === address);
  return entry ? entry.line : lineForAddress(listing, address);
}

function failingResult(
  message: string,
  line: number | null,
  ip: number,
  steps: number,
  trace: X86StepTrace[],
  context: X86Context | null,
): X86RunResult {
  const registers = context ? { ...context.registers } : undefined;
  return {
    steps,
    trace,
    finalRegisters: registers ?? emptyRegisters(),
    finalFlags: numberToFlags(registers?.flags ?? 0x0202),
    console: context ? [...context.output] : [],
    portValues: portValuesFrom(trace),
    accesses: accessesFrom(trace),
    haltReason: "error",
    error: { message, line, ip },
    elapsedMs: 0,
  };
}

function emptyRegisters() {
  return { ...(createContext(createMemory(), createNullDevice(), { entryPoint: 0 }).registers) };
}

function portValuesFrom(trace: X86StepTrace[]): Record<number, number> {
  const values: Record<number, number> = {};
  for (const step of trace) {
    for (const access of step.io) {
      values[access.port] = access.value;
    }
  }

  return values;
}

function accessesFrom(trace: X86StepTrace[]) {
  const accesses: MemoryAccess[] = [];
  for (const step of trace) {
    accesses.push(...step.reads, ...step.writes);
  }

  return accesses;
}

export function simulateX86(request: X86RunRequest): X86RunResult {
  const started = Date.now();
  const assembly = assemble(request.source);
  const errors = assembly.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    const first = errors[0];
    return failingResult(first.message, first.line, 0, 0, [], null);
  }

  const memory = createMemory();
  for (let index = 0; index < assembly.bytes.length; index += 1) {
    memory[index] = assembly.bytes[index] & 0xff;
  }

  const context = createContext(memory, request.device ?? createNullDevice(), { entryPoint: assembly.entryPoint });
  const maxSteps = Math.max(1, request.maxSteps ?? defaultStepLimit);
  const trace: X86StepTrace[] = [];
  const listing = request.listing ?? assembly.listing;
  let steps = 0;
  let error: X86RunResult["error"];

  while (steps < maxSteps && !context.halted && !context.terminated) {
    const ip = context.registers.ip;
    try {
      executeInstruction(context);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      error = {
        message,
        line: cause instanceof X86RuntimeError || cause instanceof X86DecodeError ? imageSourceLine(listing, ip) : null,
        ip,
      };
      break;
    }

    steps += 1;
    trace.push({
      index: steps - 1,
      ip,
      segment: context.registers.cs,
      text: listing.find((item) => item.address === ip)?.text ?? describeAddress(ip),
      sourceLine: imageSourceLine(listing, ip),
      registers: { ...context.registers },
      reads: [...context.reads],
      writes: [...context.writes],
      io: [...context.io],
      executed: true,
    });
  }

  const haltReason: X86RunResult["haltReason"] = error
    ? "error"
    : context.terminated
      ? "terminated"
      : context.halted
        ? "halted"
        : "step-limit";

  return {
    steps,
    trace,
    finalRegisters: { ...context.registers },
    finalFlags: numberToFlags(context.registers.flags),
    console: [...context.output],
    portValues: portValuesFrom(trace),
    accesses: accessesFrom(trace),
    haltReason,
    error,
    elapsedMs: Date.now() - started,
  };
}

function describeAddress(ip: number): string {
  return `db ${ip.toString(16).toUpperCase().padStart(4, "0")}h`;
}

export function stepX86(context: X86Context, listing: X86ListingEntry[]): X86StepTrace {
  const ip = context.registers.ip;
  executeInstruction(context);
  return {
    index: context.io.length,
    ip,
    segment: context.registers.cs,
    text: listing.find((item) => item.address === ip)?.text ?? describeAddress(ip),
    sourceLine: imageSourceLine(listing, ip),
    registers: { ...context.registers },
    reads: [...context.reads],
    writes: [...context.writes],
    io: [...context.io],
    executed: true,
  };
}

export function createSession(
  source: string,
  device: X86Device,
  options: { dataSegment?: number } = {},
): { context: X86Context; listing: X86ListingEntry[]; entryPoint: number; error?: string } {
  const assembly = assemble(source);
  const errors = assembly.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    return { context: createContext(createMemory(), device, { entryPoint: assembly.entryPoint }), listing: assembly.listing, entryPoint: assembly.entryPoint, error: errors[0].message };
  }

  const memory = createMemory();
  for (let index = 0; index < assembly.bytes.length; index += 1) {
    memory[index] = assembly.bytes[index] & 0xff;
  }

  const context = createContext(memory, device, {
    entryPoint: assembly.entryPoint,
    dataSegment: options.dataSegment,
  });

  return { context, listing: assembly.listing, entryPoint: assembly.entryPoint };
}

export function flagSignalKeys(): FlagKey[] {
  return flagBits.map(([key]) => key);
}

export function flagLabelFor(key: FlagKey): string {
  return flagLabels.find((entry) => entry.key === key)?.name ?? key.toUpperCase();
}
