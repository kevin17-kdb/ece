import { tokenize, type Token } from "./lexer";
import {
  VerilogError,
  type AssignStatement,
  type CaseItem,
  type Declaration,
  type Expression,
  type InstanceConnection,
  type ModuleDeclaration,
  type ModuleInstance,
  type ParameterDeclaration,
  type ParameterOverride,
  type ParsedSource,
  type PortDeclaration,
  type PortDirection,
  type PrimitiveInstance,
  type PrimitiveName,
  type ProcessBlock,
  type RangeSpec,
  type Sensitivity,
  type SourceRange,
  type Statement,
  type Timescale,
} from "./types";

const gatePrimitives: PrimitiveName[] = ["and", "nand", "or", "nor", "xor", "xnor", "not", "buf"];

const systemVerilogOnly = new Set(["logic", "bit", "int", "byte", "shortint", "longint", "enum", "struct", "typedef", "always_comb", "always_ff", "always_latch", "unique", "priority"]);

const unsupportedKeywords = new Set([
  "function", "task", "generate", "endgenerate", "genvar", "real", "specify",
  "endspecify", "table", "endtable", "primitive", "endprimitive", "event",
  "supply0", "supply1", "highz0", "highz1", "pullup", "pulldown", "wait",
  "fork", "join", "disable", "deassign", "force", "release", "defparam",
]);

interface SelectSuffix {
  kind: "index" | "part";
  index?: Expression;
  msb?: Expression;
  lsb?: Expression;
}

interface ModuleItemContext {
  moduleName: string;
  ansiPorts: boolean;
  headerPorts: PortDeclaration[];
  plainPortNames: string[];
  ports: PortDeclaration[];
  declarations: Declaration[];
  parameters: ParameterDeclaration[];
  assigns: AssignStatement[];
  processes: ProcessBlock[];
  instances: ModuleInstance[];
  primitives: PrimitiveInstance[];
  start: SourceRange;
}

class Parser {
  private readonly tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ParsedSource {
    const modules: ModuleDeclaration[] = [];
    const directives: string[] = [];
    let timescale: Timescale | null = null;

    while (!this.isAtEnd()) {
      if (this.matchDirective("`timescale")) {
        timescale = this.parseTimescale(this.previous().text);
        continue;
      }

      if (this.peek().kind === "directive") {
        directives.push(this.advance().text);
        continue;
      }

      if (this.checkKeyword("module")) {
        modules.push(this.parseModule());
        continue;
      }

      if (this.peek().kind === "keyword" && unsupportedKeywords.has(this.peek().text)) {
        throw new VerilogError(`“${this.peek().text}” is not supported in this Verilog subset.`, this.peek().range);
      }

      throw new VerilogError(
        this.peek().kind === "eof"
          ? "Unexpected end of file: expected a module declaration."
          : `Unexpected token “${this.peek().text}” at the top level.`,
        this.peek().range,
      );
    }

    return { modules, timescale, directives };
  }

  private parseTimescale(text: string): Timescale {
    const match = /(\d+)\s*(s|ms|us|ns|ps|fs)\s*\/\s*(\d+)\s*(s|ms|us|ns|ps|fs)/.exec(text);
    if (!match) {
      throw new VerilogError("Malformed `timescale directive.", this.previous().range);
    }

    const scale: Record<string, number> = {
      s: 1,
      ms: 1_000,
      us: 1_000_000,
      ns: 1_000_000_000,
      ps: 1_000_000_000_000,
      fs: 1_000_000_000_000_000,
    };

    return { unit: scale[match[2] as string] ?? 1, precision: scale[match[4] as string] ?? 1 };
  }

  private parseModule(): ModuleDeclaration {
    const start = this.expectKeyword("module").range;
    const name = this.expectIdentifier("a module name").text;
    const headerParameters = this.parseParameterList();
    const { ports: headerPorts, plainNames } = this.parsePortHeader();
    this.expectDelimiter(";");

    const context: ModuleItemContext = {
      moduleName: name,
      ansiPorts: headerPorts.length > 0,
      headerPorts,
      plainPortNames: plainNames,
      ports: headerPorts.map((port) => ({ ...port })),
      declarations: [],
      parameters: [...headerParameters],
      assigns: [],
      processes: [],
      instances: [],
      primitives: [],
      start,
    };

    while (!this.checkKeyword("endmodule")) {
      if (this.isAtEnd()) {
        throw new VerilogError("Unexpected end of file inside a module: “endmodule” is missing.", start);
      }

      this.parseModuleItem(context);
    }

    this.expectKeyword("endmodule");

    return {
      name,
      file: start.file,
      ranges: start,
      ports: context.ansiPorts ? context.ports : this.mergePlainPorts(context),
      declarations: context.declarations,
      parameters: context.parameters,
      assigns: context.assigns,
      processes: context.processes,
      instances: context.instances,
      primitives: context.primitives,
    };
  }

  private mergePlainPorts(context: ModuleItemContext): PortDeclaration[] {
    const byName = new Map(context.ports.map((port) => [port.name, port]));
    const missing = context.plainPortNames.find((portName) => !byName.has(portName));
    if (missing) {
      throw new VerilogError(
        `Port “${missing}” in module “${context.moduleName}” has no input, output, or inout declaration in the module body.`,
        context.start,
      );
    }

    const extra = [...byName.keys()].filter((portName) => !context.plainPortNames.includes(portName));
    if (extra.length > 0) {
      throw new VerilogError(
        `Declaration “${extra[0]}” is not listed in the port header of module “${context.moduleName}”.`,
        context.start,
      );
    }

    return context.plainPortNames.map((portName) => byName.get(portName) as PortDeclaration);
  }

  private parseModuleItem(context: ModuleItemContext): void {
    const token = this.peek();

    if (token.kind === "keyword" && unsupportedKeywords.has(token.text)) {
      throw new VerilogError(`“${token.text}” is not supported in this Verilog subset.`, token.range);
    }

    if (token.kind === "identifier" && systemVerilogOnly.has(token.text)) {
      throw new VerilogError(`“${token.text}” is SystemVerilog; use Verilog-2001 “reg”, “wire”, and “integer” instead.`, token.range);
    }

    if (this.checkKeyword("input") || this.checkKeyword("output") || this.checkKeyword("inout")) {
      const direction = this.advance().text as PortDirection;
      const { rangeSpec, isReg } = this.parsePortModifiers();

      do {
        const nameToken = this.expectIdentifier(`a ${direction} port name`);
        this.declarePort(context, {
          name: nameToken.text,
          direction,
          rangeSpec,
          isReg,
          range: nameToken.range,
        });
      } while (this.matchDelimiter(","));

      this.expectDelimiter(";");
      return;
    }

    if (this.checkKeyword("wire") || this.checkKeyword("reg") || this.checkKeyword("integer")) {
      const kind = this.advance().text as Declaration["kind"];
      const rangeSpec = kind === "integer" ? undefined : this.tryParseRangeSpec();
      if (this.checkKeyword("signed")) {
        throw new VerilogError("Signed nets and regs are not supported in this subset.", this.peek().range);
      }

      do {
        const nameToken = this.expectIdentifier(`a ${kind} name`);
        const initializer = this.matchOperator("=") ? this.parseExpression() : undefined;
        context.declarations.push({ name: nameToken.text, kind, rangeSpec, initializer, range: nameToken.range });
      } while (this.matchDelimiter(","));

      this.expectDelimiter(";");
      return;
    }

    if (this.checkKeyword("parameter") || this.checkKeyword("localparam")) {
      this.advance();
      this.tryParseRangeSpec();
      do {
        const nameToken = this.expectIdentifier("a parameter name");
        this.expectOperator("=");
        context.parameters.push({ name: nameToken.text, value: this.parseExpression(), range: nameToken.range });
      } while (this.matchDelimiter(","));

      this.expectDelimiter(";");
      return;
    }

    if (this.checkKeyword("assign")) {
      const assignToken = this.advance();
      const target = this.parseLValue();
      this.expectOperator("=");
      const value = this.parseExpression();
      this.expectDelimiter(";");
      context.assigns.push({ target, value, range: assignToken.range });
      return;
    }

    if (this.checkKeyword("initial")) {
      const initialToken = this.advance();
      const body = this.parseStatement();
      context.processes.push({ kind: "initial", sensitivity: [], body, range: initialToken.range });
      return;
    }

    if (this.checkKeyword("always")) {
      const alwaysToken = this.advance();
      if (this.peek().kind === "operator" && this.peek().text === "@") {
        const sensitivity = this.parseSensitivity();
        context.processes.push({ kind: "always", sensitivity, body: this.parseStatement(), range: alwaysToken.range });
        return;
      }

      if (this.peek().kind === "operator" && this.peek().text === "#") {
        const body = this.parseStatement();
        context.processes.push({ kind: "always", sensitivity: null, body, range: alwaysToken.range });
        return;
      }

      context.processes.push({ kind: "always", sensitivity: null, body: this.parseStatement(), range: alwaysToken.range });
    }

    if (this.isGatePrimitiveToken()) {
      context.primitives.push(this.parsePrimitive());
      return;
    }

    if (token.kind === "identifier") {
      const moduleName = this.advance().text;
      const parameterOverrides = this.parseParameterOverride();
      const instanceName = this.expectIdentifier("an instance name").text;
      const connections = this.parseConnectionList();
      this.expectDelimiter(";");
      context.instances.push({ moduleName, name: instanceName, parameterOverrides, connections, range: token.range });
      return;
    }

    throw new VerilogError(
      `Unexpected token “${token.text}” inside module “${context.moduleName}”.`,
      token.range,
    );
  }

  private declarePort(context: ModuleItemContext, declaration: PortDeclaration): void {
    const existing = context.ports.find((port) => port.name === declaration.name);
    if (existing) {
      const declaredInHeader = context.headerPorts.some((port) => port.name === declaration.name);
      if (declaredInHeader) {
        throw new VerilogError(`Port “${declaration.name}” is declared twice in module “${context.moduleName}”.`, declaration.range);
      }

      if (declaration.rangeSpec) {
        existing.rangeSpec = declaration.rangeSpec;
      }

      existing.isReg = existing.isReg || declaration.isReg;
      return;
    }

    if (!context.ansiPorts) {
      throw new VerilogError(
        `Declaration “${declaration.name}” is not listed in the port header of module “${context.moduleName}”.`,
        declaration.range,
      );
    }

    context.ports.push(declaration);
  }

  private parsePortModifiers(): { rangeSpec?: RangeSpec; isReg: boolean } {
    let isReg = false;
    const consumeNetType = (): void => {
      if (this.checkKeyword("reg")) {
        this.advance();
        isReg = true;
        return;
      }

      if (this.checkKeyword("wire")) {
        this.advance();
      }
    };

    if (this.checkKeyword("signed")) {
      throw new VerilogError("Signed ports are not supported in this subset.", this.peek().range);
    }

    consumeNetType();
    const rangeSpec = this.tryParseRangeSpec();
    if (!isReg) {
      if (this.checkKeyword("signed")) {
        throw new VerilogError("Signed ports are not supported in this subset.", this.peek().range);
      }

      consumeNetType();
    }

    return { rangeSpec, isReg };
  }

  private parseParameterList(): ParameterDeclaration[] {
    if (!this.matchOperator("#")) {
      return [];
    }

    this.expectDelimiter("(");
    const parameters: ParameterDeclaration[] = [];
    if (this.matchDelimiter(")")) {
      return parameters;
    }

    if (this.checkKeyword("parameter") || this.checkKeyword("localparam")) {
      this.advance();
      do {
        this.tryParseRangeSpec();
        const nameToken = this.expectIdentifier("a parameter name");
        this.expectOperator("=");
        parameters.push({ name: nameToken.text, value: this.parseExpression(), range: nameToken.range });
      } while (this.matchDelimiter(","));

      this.matchDelimiter(";");
      this.expectDelimiter(")");
      return parameters;
    }

    do {
      this.tryParseRangeSpec();
      const nameToken = this.expectIdentifier("a parameter name");
      this.expectOperator("=");
      parameters.push({ name: nameToken.text, value: this.parseExpression(), range: nameToken.range });
    } while (this.matchDelimiter(","));

    this.expectDelimiter(")");
    return parameters;
  }

  private parseParameterOverride(): ParameterOverride[] {
    if (!this.matchOperator("#")) {
      return [];
    }

    this.expectDelimiter("(");
    const overrides: ParameterOverride[] = [];
    if (this.matchDelimiter(")")) {
      return overrides;
    }

    do {
      if (this.peekDelimiter(".")) {
        const dot = this.advance();
        const name = this.expectIdentifier("a parameter name");
        this.expectDelimiter("(");
        const value = this.peekDelimiter(")") ? emptyExpression(dot.range) : this.parseExpression();
        this.expectDelimiter(")");
        overrides.push({ name: name.text, value, range: name.range });
        continue;
      }

      const expression = this.parseExpression();
      overrides.push({ name: null, value: expression, range: expression.range });
    } while (this.matchDelimiter(","));

    this.expectDelimiter(")");
    return overrides;
  }

  private parsePortHeader(): { ports: PortDeclaration[]; plainNames: string[] } {
    if (!this.matchDelimiter("(")) {
      return { ports: [], plainNames: [] };
    }

    const ports: PortDeclaration[] = [];
    const plainNames: string[] = [];
    if (this.matchDelimiter(")")) {
      return { ports, plainNames };
    }

    if (this.peekDelimiter(".")) {
      throw new VerilogError("SystemVerilog “.*” port connections are not supported; declare ports in the module header.", this.peek().range);
    }

    const ansi = this.peek().kind === "keyword" && ["input", "output", "inout"].includes(this.peek().text);
    do {
      if (ansi) {
        const direction = this.advance().text as PortDirection;
        const { rangeSpec, isReg } = this.parsePortModifiers();

        const nameToken = this.expectIdentifier("a port name");
        ports.push({ name: nameToken.text, direction, rangeSpec, isReg, range: nameToken.range });
        continue;
      }

      const nameToken = this.expectIdentifier("a port name");
      plainNames.push(nameToken.text);
    } while (this.matchDelimiter(","));

    this.expectDelimiter(")");
    return { ports, plainNames };
  }

  private parseConnectionList(): InstanceConnection[] {
    this.expectDelimiter("(");
    const connections: InstanceConnection[] = [];
    if (this.matchDelimiter(")")) {
      return connections;
    }

    if (this.peekDelimiter(".")) {
      do {
        this.advance();
        const portName = this.expectIdentifier("a port name").text;
        this.expectDelimiter("(");
        const expression = this.peekDelimiter(")") ? emptyExpression(this.peek().range) : this.parseExpression();
        this.expectDelimiter(")");
        connections.push({ port: portName, expression });
      } while (this.matchDelimiter(","));

      this.expectDelimiter(")");
      return connections;
    }

    do {
      if (this.peekDelimiter(",") || this.peekDelimiter(")")) {
        connections.push({ port: null, expression: emptyExpression(this.peek().range) });
        continue;
      }

      connections.push({ port: null, expression: this.parseExpression() });
    } while (this.matchDelimiter(","));

    this.expectDelimiter(")");
    return connections;
  }

  private parseSensitivity(): Sensitivity[] | "*" {
    this.expectOperator("@");
    if (this.peek().kind === "operator" && this.peek().text === "*") {
      this.advance();
      return "*";
    }

    this.expectDelimiter("(");
    if (this.peek().kind === "operator" && this.peek().text === "*") {
      this.advance();
      this.expectDelimiter(")");
      return "*";
    }

    const sensitivity: Sensitivity[] = [];
    do {
      let edge: Sensitivity["edge"] = "edge";
      if (this.peek().text === "posedge" || this.peek().text === "negedge" || this.peek().text === "edge") {
        edge = this.advance().text as Sensitivity["edge"];
      }

      const expression = this.parseExpression();
      sensitivity.push({ edge, expression, range: expression.range });
      if (this.peek().text === "or") {
        this.advance();
      }
    } while (!this.peekDelimiter(")") && !this.isAtEnd());

    this.expectDelimiter(")");
    return sensitivity;
  }

  private parsePrimitive(): PrimitiveInstance {
    const token = this.advance();
    const primitive = token.text as PrimitiveName;
    let name: string | undefined;
    if (this.peek().kind === "identifier") {
      name = this.advance().text;
    }

    this.expectDelimiter("(");
    const terminals: Expression[] = [];
    if (!this.peekDelimiter(")")) {
      do {
        terminals.push(this.parseLValue());
      } while (this.matchDelimiter(","));
    }

    this.expectDelimiter(")");
    this.expectDelimiter(";");
    return { primitive, name, terminals, range: token.range };
  }

  private parseStatement(): Statement {
    const token = this.peek();

    if (this.matchDelimiter(";")) {
      return { kind: "empty", range: token.range };
    }

    if (token.kind === "keyword" && unsupportedKeywords.has(token.text)) {
      throw new VerilogError(`“${token.text}” is not supported in this Verilog subset.`, token.range);
    }

    if (token.kind === "identifier" && this.peekAt(1).kind === "delimiter" && this.peekAt(1).text === ":") {
      this.advance();
      this.advance();
      return this.parseStatement();
    }

    if (this.checkKeyword("begin")) {
      const beginToken = this.advance();
      if (this.matchDelimiter(":")) {
        this.expectIdentifier("a block name");
      }

      const items: Statement[] = [];
      while (!this.checkKeyword("end")) {
        if (this.isAtEnd()) {
          throw new VerilogError("Unexpected end of file inside a begin/end block.", beginToken.range);
        }

        items.push(this.parseStatement());
      }

      this.expectKeyword("end");
      return { kind: "block", items, range: beginToken.range };
    }

    if (this.checkKeyword("if")) {
      const ifToken = this.advance();
      this.expectDelimiter("(");
      const condition = this.parseExpression();
      this.expectDelimiter(")");
      const thenBranch = this.parseStatement();
      let elseBranch: Statement | undefined;
      if (this.checkKeyword("else")) {
        this.advance();
        elseBranch = this.parseStatement();
      }

      return { kind: "if", condition, thenBranch, elseBranch, range: ifToken.range };
    }

    if (this.checkKeyword("for")) {
      const forToken = this.advance();
      this.expectDelimiter("(");
      const initialize = this.peekDelimiter(";") ? undefined : this.parseAssignment(false);
      this.expectDelimiter(";");
      const condition = this.peekDelimiter(";") ? undefined : this.parseExpression();
      this.expectDelimiter(";");
      const step = this.peekDelimiter(")") ? undefined : this.parseAssignment(false);
      this.expectDelimiter(")");
      return { kind: "for", initialize, condition, step, body: this.parseStatement(), range: forToken.range };
    }

    if (this.checkKeyword("while")) {
      const whileToken = this.advance();
      this.expectDelimiter("(");
      const condition = this.parseExpression();
      this.expectDelimiter(")");
      return { kind: "while", condition, body: this.parseStatement(), range: whileToken.range };
    }

    if (this.checkKeyword("repeat")) {
      const repeatToken = this.advance();
      this.expectDelimiter("(");
      const count = this.parseExpression();
      this.expectDelimiter(")");
      return { kind: "repeat", count, body: this.parseStatement(), range: repeatToken.range };
    }

    if (this.checkKeyword("forever")) {
      throw new VerilogError("“forever” is not supported; use an always block with an event control.", token.range);
    }

    if (this.checkKeyword("case") || this.checkKeyword("casez")) {
      const keyword = this.advance().text as "case" | "casez";
      this.expectDelimiter("(");
      const condition = this.parseExpression();
      this.expectDelimiter(")");
      const items: CaseItem[] = [];
      while (!this.checkKeyword("endcase")) {
        if (this.isAtEnd()) {
          throw new VerilogError("Unexpected end of file inside a case statement.", token.range);
        }

        if (this.checkKeyword("default")) {
          const defaultToken = this.advance();
          this.matchDelimiter(":");
          items.push({ expressions: null, body: this.parseStatement(), range: defaultToken.range });
          continue;
        }

        const expressions: Expression[] = [];
        do {
          expressions.push(this.parseExpression());
        } while (this.matchDelimiter(","));

        this.expectDelimiter(":");
        items.push({ expressions, body: this.parseStatement(), range: expressions[0]?.range ?? token.range });
      }

      this.expectKeyword("endcase");
      return { kind: "case", condition, keyword, items, range: token.range };
    }

    if (token.kind === "operator" && token.text === "#") {
      const delayToken = this.advance();
      let amount: Expression;
      if (this.matchDelimiter("(")) {
        amount = this.parseExpression();
        this.expectDelimiter(")");
      } else {
        amount = this.parsePrimary();
      }

      if (this.matchDelimiter(";")) {
        return { kind: "delay", amount, range: delayToken.range };
      }

      const body = this.parseStatement();
      this.matchDelimiter(";");
      return { kind: "delay", amount, body, range: delayToken.range };
    }

    if (token.kind === "operator" && token.text === "@") {
      const waitToken = this.peek();
      const sensitivity = this.parseSensitivity();
      if (this.matchDelimiter(";")) {
        return { kind: "eventWait", sensitivity, range: waitToken.range };
      }

      const body = this.parseStatement();
      this.matchDelimiter(";");
      return { kind: "eventWait", sensitivity, body, range: waitToken.range };
    }

    if (token.kind === "systemIdentifier") {
      const call = this.parseSystemCall();
      this.expectDelimiter(";");
      return call;
    }

    const assignment = this.parseAssignment();
    if (assignment) {
      return assignment;
    }

    throw new VerilogError(`Unsupported statement starting with “${token.text}”.`, token.range);
  }

  private parseAssignment(consumeSemicolon = true): Statement | undefined {
    const start = this.peek();
    if (start.kind !== "identifier") {
      return undefined;
    }

    const saved = this.position;
    this.advance();
    let target: Expression = { kind: "identifier", name: start.text, range: start.range };
    while (this.peek().kind === "delimiter" && this.peek().text === "[") {
      const suffix = this.parseSelectSuffix();
      target = suffix.kind === "part"
        ? { kind: "partSelect", target, msb: suffix.msb as Expression, lsb: suffix.lsb as Expression, range: start.range }
        : { kind: "index", target, index: suffix.index as Expression, range: start.range };
    }

    const operator = this.peek();
    if (operator.kind !== "operator" || (operator.text !== "=" && operator.text !== "<=")) {
      this.position = saved;
      return undefined;
    }

    this.advance();
    const value = this.parseExpression();
    if (consumeSemicolon) {
      this.expectDelimiter(";");
    }
    if (operator.text === "=") {
      return { kind: "blockingAssign", target, value, range: start.range };
    }

    return { kind: "nonBlockingAssign", target, value, range: start.range };
  }

  private parseSelectSuffix(): SelectSuffix {
    this.expectDelimiter("[");
    const first = this.parseExpression();
    if (this.matchOperator(":")) {
      const lsb = this.parseExpression();
      this.expectDelimiter("]");
      return { kind: "part", msb: first, lsb };
    }

    this.expectDelimiter("]");
    return { kind: "index", index: first };
  }

  private parseSystemCall(): Statement {
    const token = this.advance();
    const name = token.text;
    const args: Expression[] = [];
    if (this.peekDelimiter("(")) {
      this.expectDelimiter("(");
      if (!this.peekDelimiter(")")) {
        do {
          args.push(this.parseExpression());
        } while (this.matchDelimiter(","));
      }

      this.expectDelimiter(")");
    }

    return { kind: "systemCall", name, args, range: token.range };
  }

  private parseLValue(): Expression {
    const token = this.peek();
    if (token.kind !== "identifier") {
      throw new VerilogError(`Expected a signal name but found “${token.text}”.`, token.range);
    }

    this.advance();
    let expression: Expression = { kind: "identifier", name: token.text, range: token.range };
    while (this.peek().kind === "delimiter" && this.peek().text === "[") {
      const suffix = this.parseSelectSuffix();
      expression = suffix.kind === "part"
        ? { kind: "partSelect", target: expression, msb: suffix.msb as Expression, lsb: suffix.lsb as Expression, range: token.range }
        : { kind: "index", target: expression, index: suffix.index as Expression, range: token.range };
    }

    return expression;
  }

  private parseExpression(): Expression {
    return this.parseConditional();
  }

  private parseConditional(): Expression {
    const condition = this.parseBinary(0);
    if (!this.matchOperator("?")) {
      return condition;
    }

    const whenTrue = this.parseConditional();
    this.expectOperator(":");
    const whenFalse = this.parseConditional();
    return { kind: "conditional", condition, whenTrue, whenFalse, range: condition.range };
  }

  private parseBinary(level: number): Expression {
    const precedenceTable: string[][] = [
      ["||"],
      ["&&"],
      ["|"],
      ["^", "~^", "^~"],
      ["&"],
      ["==", "!=", "===", "!=="],
      ["<", "<=", ">", ">="],
      ["<<", ">>", "<<<", ">>>"],
      ["+", "-"],
      ["*", "/", "%"],
    ];

    if (level >= precedenceTable.length) {
      return this.parseUnary();
    }

    let left = this.parseBinary(level + 1);
    const operators = precedenceTable[level];
    while (this.peek().kind === "operator" && operators.includes(this.peek().text)) {
      const operator = this.advance().text;
      const right = this.parseBinary(level + 1);
      left = { kind: "binary", operator: operator as never, left, right, range: left.range };
    }

    return left;
  }

  private parseUnary(): Expression {
    const token = this.peek();
    if (token.kind === "operator" && ["+", "-", "!", "~", "&", "|", "^"].includes(token.text)) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: "unary", operator: token.text as "+" | "-" | "!" | "~" | "&" | "|" | "^", operand, range: token.range };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const token = this.peek();

    if (token.kind === "number") {
      this.advance();
      const width = token.based?.width ?? 32;
      return {
        kind: "number",
        value: token.value ?? parseBasedLiteral(token),
        width,
        digits:
          token.based && /[xXzZ?]/.test(token.based.digits)
            ? basedLiteralBits(token.based.digits, token.based.base, width)
            : undefined,
        signed: token.based?.signed ?? false,
        range: token.range,
      };
    }

    if (token.kind === "string") {
      this.advance();
      return { kind: "string", value: token.text, range: token.range };
    }

    if (token.kind === "identifier") {
      this.advance();
      let expression: Expression = { kind: "identifier", name: token.text, range: token.range };
      while (this.peek().kind === "delimiter" && this.peek().text === "[") {
        const suffix = this.parseSelectSuffix();
        expression = suffix.kind === "part"
          ? { kind: "partSelect", target: expression, msb: suffix.msb as Expression, lsb: suffix.lsb as Expression, range: token.range }
          : { kind: "index", target: expression, index: suffix.index as Expression, range: token.range };
      }

      return expression;
    }

    if (this.peekDelimiter("(")) {
      this.advance();
      const inner = this.parseExpression();
      this.expectDelimiter(")");
      return inner;
    }

    if (this.peekDelimiter("{")) {
      const opening = this.advance();
      const first = this.parseExpression();

      if (this.peekDelimiter("{")) {
        this.advance();
        const items: Expression[] = [];
        if (this.peekDelimiter("}")) {
          throw new VerilogError("Replication needs at least one value: {2{y}}.", opening.range);
        }

        do {
          items.push(this.parseExpression());
        } while (this.matchDelimiter(","));

        this.expectDelimiter("}");
        this.expectDelimiter("}");
        return { kind: "replicate", count: first, items, range: opening.range };
      }

      const items: Expression[] = [first];
      while (this.matchDelimiter(",")) {
        items.push(this.parseExpression());
      }

      this.expectDelimiter("}");
      return { kind: "concat", items, range: opening.range };
    }

    if (token.kind === "systemIdentifier") {
      this.advance();
      const args: Expression[] = [];
      if (this.peekDelimiter("(")) {
        this.expectDelimiter("(");
        if (!this.peekDelimiter(")")) {
          do {
            args.push(this.parseExpression());
          } while (this.matchDelimiter(","));
        }

        this.expectDelimiter(")");
      }

      return { kind: "call", name: token.text, args, range: token.range };
    }

    throw new VerilogError(`Expected an expression but found “${token.text}”.`, token.range);
  }

  private tryParseRangeSpec(): RangeSpec | undefined {
    if (!(this.peek().kind === "delimiter" && this.peek().text === "[")) {
      return undefined;
    }

    const opening = this.advance();
    const msb = this.parseExpression();
    if (!this.matchOperator(":")) {
      throw new VerilogError("Only “[msb:lsb]” ranges are supported.", opening.range);
    }

    const lsb = this.parseExpression();
    this.expectDelimiter("]");
    return { msb, lsb, range: opening.range };
  }

  private peek(): Token {
    return this.tokens[this.position];
  }

  private peekAt(offset: number): Token {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)];
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.position - 1)];
  }

  private advance(): Token {
    const token = this.tokens[this.position];
    this.position = Math.min(this.position + 1, this.tokens.length - 1);
    return token;
  }

  private isAtEnd(): boolean {
    return this.peek().kind === "eof";
  }

  private checkKeyword(keyword: string): boolean {
    const token = this.peek();
    return token.kind === "keyword" && token.text === keyword;
  }

  private matchDirective(directive: string): boolean {
    if (this.peek().kind === "directive" && this.peek().text.startsWith(directive)) {
      this.advance();
      return true;
    }

    return false;
  }

  private expectKeyword(keyword: string): Token {
    if (!this.checkKeyword(keyword)) {
      throw new VerilogError(`Expected “${keyword}” but found “${this.peek().text}”.`, this.peek().range);
    }

    return this.advance();
  }

  private expectIdentifier(purpose: string): Token {
    const token = this.peek();
    if (token.kind !== "identifier") {
      throw new VerilogError(`Expected ${purpose} but found “${token.text}”.`, token.range);
    }

    return this.advance();
  }

  private expectDelimiter(delimiter: string): Token {
    if (!this.peekDelimiter(delimiter)) {
      throw new VerilogError(`Expected “${delimiter}” but found “${this.peek().text}”.`, this.peek().range);
    }

    return this.advance();
  }

  private peekDelimiter(delimiter: string): boolean {
    const token = this.peek();
    return (token.kind === "delimiter" || token.kind === "operator") && token.text === delimiter;
  }

  private matchDelimiter(delimiter: string): boolean {
    if (!this.peekDelimiter(delimiter)) {
      return false;
    }

    this.advance();
    return true;
  }

  private expectOperator(operator: string): Token {
    if (!this.matchOperator(operator)) {
      throw new VerilogError(`Expected “${operator}” but found “${this.peek().text}”.`, this.peek().range);
    }

    return this.previous();
  }

  private matchOperator(operator: string): boolean {
    const token = this.peek();
    if (token.kind !== "operator" || token.text !== operator) {
      return false;
    }

    this.advance();
    return true;
  }

  private isGatePrimitiveToken(): boolean {
    const token = this.peek();
    return (token.kind === "keyword" || token.kind === "identifier") && gatePrimitives.includes(token.text as PrimitiveName);
  }
}

function parseBasedLiteral(token: Token): bigint {
  const based = token.based;
  if (!based) {
    return 0n;
  }

  const digits = based.digits.replace(/[xXzZ?]/g, "0") || "0";
  if (based.base === 10) {
    return BigInt(digits);
  }

  if (based.base === 2) {
    return BigInt(`0b${digits}`);
  }

  if (based.base === 8) {
    return BigInt(`0o${digits}`);
  }

  return BigInt(`0x${digits}`);
}

function basedLiteralBits(digits: string, base: number, width: number): string {
  const size = base === 2 ? 1 : base === 8 ? 3 : base === 16 ? 4 : 0;
  if (size === 0) {
    return "";
  }

  let bits = "";
  for (const character of digits.replace(/_/g, "")) {
    if (/[xXzZ]/.test(character)) {
      const fill = /[zZ]/.test(character) ? "z" : "x";
      bits += fill.repeat(size);
      continue;
    }

    bits += Number.parseInt(character, 16).toString(2).padStart(size, "0");
  }

  const padded = bits.length >= width ? bits.slice(bits.length - width) : bits.padStart(width, base === 2 ? "0" : "0");
  return padded;
}

function emptyExpression(range: SourceRange): Expression {
  return { kind: "number", value: 0n, width: 1, signed: false, range };
}

export function parseSource(source: string, file: string): ParsedSource {
  return new Parser(tokenize(source, file)).parse();
}

export function parseSources(sources: { path: string; content: string }[]): ParsedSource {
  const modules: ModuleDeclaration[] = [];
  const directives: string[] = [];
  let timescale: Timescale | null = null;

  for (const source of sources) {
    const parsed = parseSource(source.content, source.path);
    modules.push(...parsed.modules);
    directives.push(...parsed.directives);
    timescale = parsed.timescale ?? timescale;
  }

  return { modules, timescale, directives };
}
