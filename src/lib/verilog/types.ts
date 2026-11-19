/**
 * Verilog subset front end: shared types.
 *
 * Supported subset (documented in the workspace help panel):
 *   - modules with ANSI or non-ANSI port lists, `parameter` constants
 *   - `input` / `output` / `inout`, `wire`, `reg`, `integer`
 *   - `assign`, `always @(...)`, `always @*`, `initial`
 *   - module instantiation (named and positional ports), gate primitives
 *   - blocking and non-blocking assignment, `if`, `case`/`casez`, `for`,
 *     `while`, `repeat`, `begin`/`end`, `#delay`, `@(posedge/negedge/edge)`
 *   - sized literals, bit selects, part selects, concatenation, replication,
 *     the usual arithmetic / bitwise / logical / comparison operators
 *   - `$display`, `$write`, `$monitor`, `$finish`, `$time`
 *
 * Everything else is reported as an explicit error with a source location
 * instead of being silently ignored.
 */

export interface SourceRange {
  line: number;
  column: number;
  file: string;
}

export class VerilogError extends Error {
  readonly range: SourceRange;

  constructor(message: string, range: SourceRange) {
    super(message);
    this.name = "VerilogError";
    this.range = range;
  }
}

export interface VectorRange {
  msb: bigint;
  lsb: bigint;
}

export function rangeWidth(range: VectorRange): number {
  const width = range.msb >= range.lsb ? range.msb - range.lsb : range.lsb - range.msb;
  return Number(width) + 1;
}

export type FourStateValue = string;

export type BinaryOperator =
  | "+" | "-" | "*" | "/" | "%"
  | "&" | "|" | "^" | "~^" | "^~"
  | "<<" | ">>" | "<<<" | ">>>"
  | "<" | "<=" | ">" | ">="
  | "==" | "!=" | "===" | "!=="
  | "&&" | "||";

export type UnaryOperator = "+" | "-" | "!" | "~" | "&" | "|" | "^";

export type Expression =
  | { kind: "number"; value: bigint; width: number; signed: boolean; digits?: string; range: SourceRange }
  | { kind: "string"; value: string; range: SourceRange }
  | { kind: "identifier"; name: string; range: SourceRange }
  | { kind: "index"; target: Expression; index: Expression; range: SourceRange }
  | { kind: "partSelect"; target: Expression; msb: Expression; lsb: Expression; range: SourceRange }
  | { kind: "unary"; operator: UnaryOperator; operand: Expression; range: SourceRange }
  | { kind: "binary"; operator: BinaryOperator; left: Expression; right: Expression; range: SourceRange }
  | { kind: "conditional"; condition: Expression; whenTrue: Expression; whenFalse: Expression; range: SourceRange }
  | { kind: "concat"; items: Expression[]; range: SourceRange }
  | { kind: "replicate"; count: Expression; items: Expression[]; range: SourceRange }
  | { kind: "call"; name: string; args: Expression[]; range: SourceRange };

export type LValue = Expression;

export interface RangeSpec {
  msb: Expression;
  lsb: Expression;
  range: SourceRange;
}

export type EdgeKind = "posedge" | "negedge" | "edge";

export interface Sensitivity {
  edge: EdgeKind;
  expression: Expression;
  range: SourceRange;
}

export type Statement =
  | { kind: "empty"; range: SourceRange }
  | { kind: "blockingAssign"; target: LValue; value: Expression; range: SourceRange }
  | { kind: "nonBlockingAssign"; target: LValue; value: Expression; range: SourceRange }
  | { kind: "if"; condition: Expression; thenBranch: Statement; elseBranch?: Statement; range: SourceRange }
  | { kind: "case"; condition: Expression; keyword: "case" | "casez"; items: CaseItem[]; range: SourceRange }
  | { kind: "for"; initialize?: Statement; condition?: Expression; step?: Statement; body: Statement; range: SourceRange }
  | { kind: "while"; condition: Expression; body: Statement; range: SourceRange }
  | { kind: "repeat"; count: Expression; body: Statement; range: SourceRange }
  | { kind: "block"; name?: string; items: Statement[]; range: SourceRange }
  | { kind: "delay"; amount: Expression; body?: Statement; range: SourceRange }
  | { kind: "eventWait"; sensitivity: Sensitivity[] | "*"; body?: Statement; range: SourceRange }
  | { kind: "systemCall"; name: string; args: Expression[]; range: SourceRange };

export interface CaseItem {
  expressions: Expression[] | null;
  body: Statement;
  range: SourceRange;
}

export type PortDirection = "input" | "output" | "inout";

export interface PortDeclaration {
  name: string;
  direction: PortDirection;
  rangeSpec?: RangeSpec;
  isReg: boolean;
  range: SourceRange;
}

export interface Declaration {
  name: string;
  kind: "wire" | "reg" | "integer";
  rangeSpec?: RangeSpec;
  initializer?: Expression;
  range: SourceRange;
}

export interface AssignStatement {
  target: LValue;
  value: Expression;
  range: SourceRange;
}

export interface ProcessBlock {
  kind: "always" | "initial";
  sensitivity: Sensitivity[] | "*" | null;
  body: Statement;
  range: SourceRange;
}

export interface ParameterOverride {
  name: string | null;
  value: Expression;
  range: SourceRange;
}

export interface InstanceConnection {
  port: string | null;
  expression: Expression;
}

export interface ModuleInstance {
  moduleName: string;
  name: string;
  parameterOverrides: ParameterOverride[];
  connections: InstanceConnection[];
  range: SourceRange;
}

export type PrimitiveName = "and" | "nand" | "or" | "nor" | "xor" | "xnor" | "not" | "buf";

export interface PrimitiveInstance {
  primitive: PrimitiveName;
  name?: string;
  terminals: LValue[];
  range: SourceRange;
}

export interface ParameterDeclaration {
  name: string;
  value: Expression;
  range: SourceRange;
}

export interface ModuleDeclaration {
  name: string;
  file: string;
  ranges: SourceRange;
  ports: PortDeclaration[];
  declarations: Declaration[];
  parameters: ParameterDeclaration[];
  assigns: AssignStatement[];
  processes: ProcessBlock[];
  instances: ModuleInstance[];
  primitives: PrimitiveInstance[];
}

export interface Timescale {
  unit: number;
  precision: number;
}

export interface ParsedSource {
  modules: ModuleDeclaration[];
  timescale: Timescale | null;
  directives: string[];
}
