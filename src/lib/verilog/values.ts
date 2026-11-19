import { VerilogError, type SourceRange } from "./types";

export type LogicDigit = "0" | "1" | "x" | "z";

const digitPairs: Record<LogicDigit, string> = { "0": "10", "1": "11", x: "00", z: "01" };

export function digitAt(value: string, position: number): LogicDigit {
  const pair = value.slice(position * 2, position * 2 + 2);
  if (pair === digitPairs["0"]) {
    return "0";
  }

  if (pair === digitPairs["1"]) {
    return "1";
  }

  if (pair === digitPairs.z) {
    return "z";
  }

  return "x";
}

export function digitValue(digit: LogicDigit): string {
  return digitPairs[digit];
}

export function valueWidth(value: string): number {
  return Math.floor(value.length / 2);
}

export function fillValue(width: number, digit: LogicDigit = "x"): string {
  return digitValue(digit).repeat(Math.max(1, width));
}

export function binaryToValue(binary: string): string {
  let value = "";
  for (const character of binary) {
    value += character === "0" ? digitPairs["0"] : character === "1" ? digitPairs["1"] : character === "z" || character === "Z" ? digitPairs.z : digitPairs.x;
  }

  return value;
}

export function valueToBinary(value: string): string {
  let binary = "";
  for (let position = 0; position < valueWidth(value); position += 1) {
    binary += digitAt(value, position);
  }

  return binary;
}

export function toNumber(value: string): bigint | null {
  const binary = valueToBinary(value);
  for (const digit of binary) {
    if (digit !== "0" && digit !== "1") {
      return null;
    }
  }

  return binary.length === 0 ? 0n : BigInt(`0b${binary}`);
}

export function fromNumber(number: bigint, width: number): string {
  const masked = number & ((1n << BigInt(Math.max(1, width))) - 1n);
  return binaryToValue(masked.toString(2).padStart(width, "0"));
}

export function hasUnknown(value: string): boolean {
  for (let position = 0; position < valueWidth(value); position += 1) {
    const digit = digitAt(value, position);
    if (digit === "x" || digit === "z") {
      return true;
    }
  }

  return false;
}

export function resize(value: string, width: number, signed = false): string {
  const currentWidth = valueWidth(value);
  if (currentWidth === width) {
    return value;
  }

  if (currentWidth < width) {
    const pad = signed && !hasUnknown(value) ? digitValue(digitAt(value, 0)) : digitValue("0");
    return pad.repeat(width - currentWidth) + value;
  }

  return value.slice((currentWidth - width) * 2);
}

function widenPair(left: string, right: string): [string, string, number] {
  const width = Math.max(valueWidth(left), valueWidth(right));
  return [resize(left, width), resize(right, width), width];
}

export function bitwiseAnd(left: string, right: string): string {
  const [a, b, width] = widenPair(left, right);
  let result = "";
  for (let position = 0; position < width; position += 1) {
    const x = digitAt(a, position);
    const y = digitAt(b, position);
    if (x === "0" || y === "0") {
      result += digitValue("0");
    } else if (x === "1" && y === "1") {
      result += digitValue("1");
    } else {
      result += digitValue("x");
    }
  }

  return result;
}

export function bitwiseOr(left: string, right: string): string {
  const [a, b, width] = widenPair(left, right);
  let result = "";
  for (let position = 0; position < width; position += 1) {
    const x = digitAt(a, position);
    const y = digitAt(b, position);
    if (x === "1" || y === "1") {
      result += digitValue("1");
    } else if (x === "0" && y === "0") {
      result += digitValue("0");
    } else {
      result += digitValue("x");
    }
  }

  return result;
}

export function bitwiseXor(left: string, right: string): string {
  const [a, b, width] = widenPair(left, right);
  let result = "";
  for (let position = 0; position < width; position += 1) {
    const x = digitAt(a, position);
    const y = digitAt(b, position);
    if (x === "x" || x === "z" || y === "x" || y === "z") {
      result += digitValue("x");
    } else {
      result += digitValue(x === y ? "0" : "1");
    }
  }

  return result;
}

export function bitwiseXnor(left: string, right: string): string {
  return bitwiseNot(bitwiseXor(left, right));
}

export function bitwiseNot(value: string): string {
  let result = "";
  for (let position = 0; position < valueWidth(value); position += 1) {
    const digit = digitAt(value, position);
    result += digitValue(digit === "0" ? "1" : digit === "1" ? "0" : "x");
  }

  return result;
}

export function reductionAnd(value: string): string {
  let result: LogicDigit = "1";
  for (let position = 0; position < valueWidth(value); position += 1) {
    const digit = digitAt(value, position);
    if (digit === "0") {
      result = "0";
      break;
    }

    if (digit === "x" || digit === "z") {
      result = "x";
    }
  }

  return digitValue(result);
}

export function reductionOr(value: string): string {
  let result: LogicDigit = "0";
  for (let position = 0; position < valueWidth(value); position += 1) {
    const digit = digitAt(value, position);
    if (digit === "1") {
      result = "1";
      break;
    }

    if (digit === "x" || digit === "z") {
      result = "x";
    }
  }

  return digitValue(result);
}

export function reductionXor(value: string): string {
  let parity = false;
  for (let position = 0; position < valueWidth(value); position += 1) {
    const digit = digitAt(value, position);
    if (digit === "x" || digit === "z") {
      return digitValue("x");
    }

    parity = parity !== (digit === "1");
  }

  return digitValue(parity ? "1" : "0");
}

export function logicalNot(value: string): string {
  const number = toNumber(value);
  if (number === null) {
    return digitValue("x");
  }

  return digitValue(number === 0n ? "1" : "0");
}

export function shiftLeft(value: string, amount: bigint): string {
  const binary = valueToBinary(value);
  if (amount < 0n) {
    return shiftRight(value, -amount);
  }

  if (amount > BigInt(binary.length)) {
    return fillValue(binary.length, "0");
  }

  return binaryToValue(binary.slice(Number(amount)) + "0".repeat(Number(amount)));
}

export function shiftRight(value: string, amount: bigint, arithmetic = false): string {
  const binary = valueToBinary(value);
  const width = binary.length;
  if (amount < 0n) {
    return shiftLeft(value, -amount);
  }

  if (amount > BigInt(width)) {
    const fill = arithmetic && (binary[0] === "1" || binary[0] === "x" || binary[0] === "z") ? binary[0] : "0";
    return fillValue(width, fill as LogicDigit);
  }

  const shift = Number(amount);
  const head = arithmetic && (binary[0] === "1" || binary[0] === "x" || binary[0] === "z") ? binary[0] : "0";
  return binaryToValue(head.repeat(shift) + binary.slice(0, width - shift));
}

export function addValues(left: string, right: string): string {
  const [a, b, width] = widenPair(left, right);
  const leftNumber = toNumber(a);
  const rightNumber = toNumber(b);
  if (leftNumber === null || rightNumber === null) {
    return fillValue(width, "x");
  }

  return fromNumber(leftNumber + rightNumber, width);
}

export function subtractValues(left: string, right: string): string {
  const [a, b, width] = widenPair(left, right);
  const leftNumber = toNumber(a);
  const rightNumber = toNumber(b);
  if (leftNumber === null || rightNumber === null) {
    return fillValue(width, "x");
  }

  return fromNumber(leftNumber - rightNumber, width);
}

export function multiplyValues(left: string, right: string): string {
  const [a, b, width] = widenPair(left, right);
  const leftNumber = toNumber(a);
  const rightNumber = toNumber(b);
  if (leftNumber === null || rightNumber === null) {
    return fillValue(width, "x");
  }

  return fromNumber(leftNumber * rightNumber, width);
}

export function divideValues(left: string, right: string): string {
  const [a, b, width] = widenPair(left, right);
  const leftNumber = toNumber(a);
  const rightNumber = toNumber(b);
  if (leftNumber === null || rightNumber === null || rightNumber === 0n) {
    return fillValue(width, "x");
  }

  return fromNumber(leftNumber / rightNumber, width);
}

export function moduloValues(left: string, right: string): string {
  const [a, b, width] = widenPair(left, right);
  const leftNumber = toNumber(a);
  const rightNumber = toNumber(b);
  if (leftNumber === null || rightNumber === null || rightNumber === 0n) {
    return fillValue(width, "x");
  }

  return fromNumber(leftNumber % rightNumber, width);
}

export function compareValues(operator: "<" | "<=" | ">" | ">=", left: string, right: string): string {
  const [a, b] = widenPair(left, right);
  const leftNumber = toNumber(a);
  const rightNumber = toNumber(b);
  if (leftNumber === null || rightNumber === null) {
    return digitValue("x");
  }

  const result = operator === "<" ? leftNumber < rightNumber
    : operator === "<=" ? leftNumber <= rightNumber
      : operator === ">" ? leftNumber > rightNumber
        : leftNumber >= rightNumber;
  return digitValue(result ? "1" : "0");
}

export function equality(operator: "==" | "!=" | "===" | "!==", left: string, right: string): string {
  const [a, b] = widenPair(left, right);
  if (operator === "===") {
    return digitValue(a === b ? "1" : "0");
  }

  if (operator === "!==") {
    return digitValue(a === b ? "0" : "1");
  }

  const leftNumber = toNumber(a);
  const rightNumber = toNumber(b);
  if (leftNumber === null || rightNumber === null) {
    return digitValue("x");
  }

  const equal = leftNumber === rightNumber;
  return digitValue(operator === "==" ? (equal ? "1" : "0") : (equal ? "0" : "1"));
}

export function logicalAnd(left: string, right: string): string {
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (leftNumber === null || rightNumber === null) {
    return digitValue("x");
  }

  return digitValue(leftNumber !== 0n && rightNumber !== 0n ? "1" : "0");
}

export function logicalOr(left: string, right: string): string {
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (leftNumber === null || rightNumber === null) {
    return digitValue("x");
  }

  return digitValue(leftNumber !== 0n || rightNumber !== 0n ? "1" : "0");
}

export function evaluateGate(primitive: string, inputs: string[]): string {
  switch (primitive) {
    case "and": return inputs.reduce((accumulator, input) => bitwiseAnd(accumulator, input), fillValue(valueWidth(inputs[0] ?? digitValue("x")), "1"));
    case "nand": return bitwiseNot(inputs.reduce((accumulator, input) => bitwiseAnd(accumulator, input), fillValue(valueWidth(inputs[0] ?? digitValue("x")), "1")));
    case "or": return inputs.reduce((accumulator, input) => bitwiseOr(accumulator, input), fillValue(valueWidth(inputs[0] ?? digitValue("x")), "0"));
    case "nor": return bitwiseNot(inputs.reduce((accumulator, input) => bitwiseOr(accumulator, input), fillValue(valueWidth(inputs[0] ?? digitValue("x")), "0")));
    case "xor": return inputs.reduce((accumulator, input) => bitwiseXor(accumulator, input), fillValue(valueWidth(inputs[0] ?? digitValue("x")), "0"));
    case "xnor": return bitwiseNot(inputs.reduce((accumulator, input) => bitwiseXor(accumulator, input), fillValue(valueWidth(inputs[0] ?? digitValue("x")), "0")));
    case "not": return bitwiseNot(inputs[0] ?? fillValue(1, "x"));
    case "buf": return inputs[0] ?? fillValue(1, "x");
    default: throw new VerilogError(`Unknown gate primitive “${primitive}”.`, { line: 0, column: 0, file: "" });
  }
}

export function formatHex(value: string): string {
  const binary = valueToBinary(value);
  const padded = binary.padStart(Math.ceil(binary.length / 4) * 4, binary[0] === "1" ? "1" : "0");
  let result = "";
  for (let index = 0; index < padded.length; index += 4) {
    const group = padded.slice(index, index + 4);
    result += /[xz]/.test(group) ? "x" : Number.parseInt(group, 2).toString(16);
  }

  return result;
}

export function formatOctal(value: string): string {
  const binary = valueToBinary(value);
  const padded = binary.padStart(Math.ceil(binary.length / 3) * 3, "0");
  let result = "";
  for (let index = 0; index < padded.length; index += 3) {
    const group = padded.slice(index, index + 3);
    result += /[xz]/.test(group) ? "x" : Number.parseInt(group, 2).toString(8);
  }

  return result;
}

export function formatDecimal(value: string): string {
  const number = toNumber(value);
  return number === null ? "x" : number.toString(10);
}

export function formatCharacter(value: string): string {
  const number = toNumber(value);
  if (number === null) {
    return "?";
  }

  if (number < 32n || number > 126n) {
    return ".";
  }

  return String.fromCodePoint(Number(number));
}

export function describeSourceRange(range: SourceRange | undefined, fallback: string): string {
  return range ? `${range.file}:${range.line}` : fallback;
}
