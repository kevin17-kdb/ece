import { VerilogError, type SourceRange } from "./types";

export type TokenKind =
  | "identifier"
  | "systemIdentifier"
  | "number"
  | "string"
  | "keyword"
  | "operator"
  | "delimiter"
  | "directive"
  | "eof";

export interface BasedLiteral {
  digits: string;
  base: number;
  width: number | null;
  signed: boolean;
}

export interface Token {
  kind: TokenKind;
  text: string;
  range: SourceRange;
  /** Numeric payload for plain decimal integer tokens. */
  value?: bigint;
  /** Payload for based literals such as 4'b1010 or 32'hdeadbeef. */
  based?: BasedLiteral;
}

export const keywords = new Set([
  "module", "endmodule", "input", "output", "inout", "wire", "reg", "integer",
  "assign", "always", "initial", "begin", "end", "if", "else", "case", "casez",
  "endcase", "for", "while", "repeat", "parameter", "localparam", "posedge",
  "negedge", "nand", "nor", "xor", "xnor", "not", "buf", "default", "function",
  "task", "generate", "endgenerate", "genvar", "real", "time", "signed",
  "automatic", "static", "wait", "fork", "join", "disable", "deassign", "force",
  "release", "specify", "endspecify", "table", "endtable", "primitive",
  "endprimitive", "defparam", "event", "tri", "wand", "wor", "supply0", "supply1",
  "highz0", "highz1", "pullup", "pulldown", "edge",
]);

const multiCharOperators = [
  "<<<", ">>>", "===", "!==", "<<=", ">>=", "==", "!=", "<=", ">=", "&&", "||",
  "<<", ">>", "~&", "~|", "~^", "^~", "->", "=>", "::",
];

const singleCharOperators = new Set([
  "+", "-", "*", "/", "%", "!", "~", "&", "|", "^", "<", ">", "=", "?", ":", ".",
  "'", "#", "@",
]);

const delimiters = new Set(["(", ")", "[", "]", "{", "}", ",", ";"]);

const baseCharacters: Record<string, number> = { b: 2, o: 8, d: 10, h: 16 };

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

export function tokenize(source: string, file: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const here = (): SourceRange => ({ line, column, file });

  function advance(count = 1): void {
    for (let step = 0; step < count; step += 1) {
      const character = source[index];
      if (character === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }

      index += 1;
    }
  }

  function readUntilLineEnd(): string {
    const startIndex = index;
    while (index < source.length && source[index] !== "\n") {
      advance();
    }

    return source.slice(startIndex, index).trim();
  }

  function readNumber(): Token {
    const start = here();
    let digits = "";
    while (index < source.length && (isDigit(source[index]) || source[index] === "_")) {
      digits += source[index];
      advance();
    }

    if (source[index] === "." && isDigit(source[index + 1] ?? "")) {
      throw new VerilogError("Real number literals are not supported in this subset.", start);
    }

    const hasBasedSuffix = source[index] === "'" && (source[index + 1] === "s" || source[index + 1] === "S" || baseCharacters[(source[index + 1] ?? "").toLowerCase()] !== undefined);
    if (!hasBasedSuffix) {
      const clean = digits.replaceAll("_", "");
      return { kind: "number", text: digits, range: start, value: BigInt(clean || "0") };
    }

    let signed = false;
    if (source[index + 1] === "s" || source[index + 1] === "S") {
      signed = true;
      advance();
    }

    const baseCharacter = (source[index + 1] ?? "").toLowerCase();
    const base = baseCharacters[baseCharacter];
    if (base === undefined) {
      throw new VerilogError("Malformed sized literal.", start);
    }

    advance(2);
    let literalDigits = "";
    while (index < source.length && (isIdentifierPart(source[index]) || source[index] === "?")) {
      if (source[index] !== "_") {
        literalDigits += source[index];
      }
      advance();
    }

    if (literalDigits.length === 0) {
      throw new VerilogError("Sized literal is missing its digits.", start);
    }

    const width = digits.replaceAll("_", "").length > 0 ? Number(digits.replaceAll("_", "")) : null;
    return {
      kind: "number",
      text: `${digits}'${signed ? "s" : ""}${baseCharacter}${literalDigits}`,
      range: start,
      based: { digits: literalDigits, base, width, signed },
    };
  }

  while (index < source.length) {
    const character = source[index];

    if (character === " " || character === "\t" || character === "\r" || character === "\n") {
      advance();
      continue;
    }

    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        advance();
      }
      continue;
    }

    if (character === "/" && source[index + 1] === "*") {
      const start = here();
      advance(2);
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        advance();
      }

      if (index >= source.length) {
        throw new VerilogError("Unterminated block comment.", start);
      }

      advance(2);
      continue;
    }

    if (character === "`") {
      const start = here();
      advance();
      const startIndex = index;
      while (index < source.length && isIdentifierPart(source[index])) {
        advance();
      }

      const name = source.slice(startIndex, index).toLowerCase();
      if (name === "timescale") {
        const rest = readUntilLineEnd();
        tokens.push({ kind: "directive", text: "`timescale " + rest, range: start });
        continue;
      }

      if (name === "define" || name === "include") {
        const rest = readUntilLineEnd();
        tokens.push({ kind: "directive", text: `\`${name}${rest}`, range: start });
        continue;
      }

      tokens.push({ kind: "directive", text: `\`${name}`, range: start });
      continue;
    }

    if (character === '"') {
      const start = here();
      advance();
      let value = "";
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          advance(2);
          continue;
        }

        if (source[index] === "\n") {
          throw new VerilogError("Unterminated string literal.", start);
        }

        value += source[index];
        advance();
      }

      if (index >= source.length) {
        throw new VerilogError("Unterminated string literal.", start);
      }

      advance();
      tokens.push({ kind: "string", text: value, range: start });
      continue;
    }

    if (isDigit(character) || (character === "'" && baseCharacters[(source[index + 1] ?? "").toLowerCase()] !== undefined)) {
      tokens.push(readNumber());
      continue;
    }

    if (character === "$") {
      const start = here();
      const startIndex = index;
      advance();
      while (index < source.length && isIdentifierPart(source[index])) {
        advance();
      }

      tokens.push({ kind: "systemIdentifier", text: source.slice(startIndex, index), range: start });
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = here();
      const startIndex = index;
      while (index < source.length && isIdentifierPart(source[index])) {
        advance();
      }

      const text = source.slice(startIndex, index);
      tokens.push({ kind: keywords.has(text) ? "keyword" : "identifier", text, range: start });
      continue;
    }

    const start = here();
    const threeCharacters = source.slice(index, index + 3);
    if (multiCharOperators.includes(threeCharacters)) {
      advance(3);
      tokens.push({ kind: "operator", text: threeCharacters, range: start });
      continue;
    }

    const twoCharacters = source.slice(index, index + 2);
    if (multiCharOperators.includes(twoCharacters)) {
      advance(2);
      tokens.push({ kind: "operator", text: twoCharacters, range: start });
      continue;
    }

    if (singleCharOperators.has(character)) {
      advance();
      tokens.push({ kind: "operator", text: character, range: start });
      continue;
    }

    if (delimiters.has(character)) {
      advance();
      tokens.push({ kind: "delimiter", text: character, range: start });
      continue;
    }

    throw new VerilogError(`Unexpected character “${character}”.`, start);
  }

  tokens.push({ kind: "eof", text: "", range: here() });
  return tokens;
}
