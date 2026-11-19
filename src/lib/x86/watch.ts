import { numberToFlags, type X86Registers } from "./types";

export interface WatchEvaluation {
  text: string;
  value: number | null;
  error?: string;
}

const wordRegisters = new Set(["ax", "bx", "cx", "dx", "si", "di", "bp", "sp", "cs", "ds", "ss", "es", "ip"]);
const byteRegisters: Record<string, "low" | "high"> = {
  al: "low",
  ah: "high",
  bl: "low",
  bh: "high",
  cl: "low",
  ch: "high",
  dl: "low",
  dh: "high",
};
const flagNames = new Set(["cf", "pf", "af", "zf", "sf", "tf", "if", "df", "of"]);

/**
 * Evaluates a small watch expression against the live 8086 state.
 *
 * Supported syntax:
 *   - word/byte registers: ax, bx, al, ah, sp, ip ...
 *   - flags: cf, zf, of ... (1 or 0), and "flags" for the raw word
 *   - numbers: 42, 0x2a, 2Ah, 'c'
 *   - memory byte reads: [ds:0100], [0100], [bx], [bx+si+2], ds:0100
 *   - simple +/- arithmetic between the above
 */
export function evaluateWatch(expression: string, registers: X86Registers, memory: Uint8Array): WatchEvaluation {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return { text: "", value: null };
  }

  try {
    const value = evaluateExpression(trimmed, registers, memory) & 0xffff;
    return { text: hex4(value), value };
  } catch (error) {
    return { text: "—", value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function hex4(value: number): string {
  return (value & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

function evaluateExpression(expression: string, registers: X86Registers, memory: Uint8Array): number {
  const terms = splitTerms(expression);
  if (terms.length === 0) {
    throw new Error("empty expression");
  }

  let total = 0;
  for (const [sign, term] of terms) {
    total += sign * evaluateTerm(term, registers, memory);
  }

  return total;
}

function splitTerms(expression: string): Array<[number, string]> {
  const terms: Array<[number, string]> = [];
  let depth = 0;
  let sign = 1;
  let buffer = "";

  for (const character of expression) {
    if (character === "[" || character === "(") {
      depth += 1;
    } else if (character === "]" || character === ")") {
      depth -= 1;
    }

    if (depth === 0 && (character === "+" || character === "-") && buffer.trim().length > 0) {
      terms.push([sign, buffer.trim()]);
      sign = character === "-" ? -1 : 1;
      buffer = "";
      continue;
    }

    buffer += character;
  }

  if (buffer.trim().length > 0) {
    terms.push([sign, buffer.trim()]);
  }

  return terms;
}

function evaluateTerm(term: string, registers: X86Registers, memory: Uint8Array): number {
  if (term.startsWith("[") && term.endsWith("]")) {
    return readMemory(term.slice(1, -1).trim(), registers, memory);
  }

  return resolveAtom(term, registers, memory);
}

function readMemory(inner: string, registers: X86Registers, memory: Uint8Array): number {
  const colon = findTopLevelColon(inner);
  if (colon >= 0) {
    const segment = resolveAtom(inner.slice(0, colon).trim(), registers, memory) & 0xffff;
    const offset = evaluateExpression(inner.slice(colon + 1).trim(), registers, memory) & 0xffff;
    return readPhysical(segment, offset, memory);
  }

  const offset = evaluateExpression(inner, registers, memory) & 0xffff;
  return readPhysical(registers.ds, offset, memory);
}

function readPhysical(segment: number, offset: number, memory: Uint8Array): number {
  const address = ((segment << 4) + offset) & 0xfffff;
  return memory[address] ?? 0;
}

function resolveAtom(atom: string, registers: X86Registers, memory: Uint8Array): number {
  const token = atom.trim();

  const colon = findTopLevelColon(token);
  if (colon >= 0) {
    const segment = resolveAtom(token.slice(0, colon).trim(), registers, memory) & 0xffff;
    const offset = evaluateExpression(token.slice(colon + 1).trim(), registers, memory) & 0xffff;
    return readPhysical(segment, offset, memory);
  }

  const lower = token.toLowerCase();
  if (wordRegisters.has(lower)) {
    return registers[lower as keyof X86Registers] & 0xffff;
  }

  if (lower in byteRegisters) {
    const base = registers[`${lower[0]}x` as keyof X86Registers] as number;
    return byteRegisters[lower] === "high" ? (base >> 8) & 0xff : base & 0xff;
  }

  if (lower === "flags") {
    return registers.flags & 0xffff;
  }

  if (flagNames.has(lower)) {
    const flags = numberToFlags(registers.flags);
    return flags[lower as keyof typeof flags] ? 1 : 0;
  }

  const number = parseNumber(token);
  if (number !== null) {
    return number;
  }

  throw new Error(`unknown symbol "${token}"`);
}

function parseNumber(token: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(token)) {
    return Number.parseInt(token.slice(2), 16);
  }

  if (/^[0-9a-f]+h$/i.test(token)) {
    return Number.parseInt(token.slice(0, -1), 16);
  }

  if (/^\d+$/.test(token)) {
    return Number.parseInt(token, 10);
  }

  const character = /^'(.)'$/.exec(token);
  if (character) {
    return character[1].charCodeAt(0);
  }

  return null;
}

function findTopLevelColon(token: string): number {
  let depth = 0;
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character === "[" || character === "(") {
      depth += 1;
    } else if (character === "]" || character === ")") {
      depth -= 1;
    } else if (character === ":" && depth === 0) {
      return index;
    }
  }

  return -1;
}
