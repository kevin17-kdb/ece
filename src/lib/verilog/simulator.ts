import { parseSources } from "./parser";
import {
  VerilogError,
  rangeWidth,
  type Declaration,
  type Expression,
  type FourStateValue,
  type ModuleDeclaration,
  type ParameterOverride,
  type PortDirection,
  type PrimitiveInstance,
  type ProcessBlock,
  type RangeSpec,
  type Sensitivity,
  type SourceRange,
  type Statement,
  type VectorRange,
} from "./types";
import {
  addValues,
  binaryToValue,
  bitwiseAnd,
  bitwiseNot,
  bitwiseOr,
  bitwiseXnor,
  bitwiseXor,
  compareValues,
  digitAt,
  digitValue,
  divideValues,
  equality,
  evaluateGate,
  fillValue,
  formatCharacter,
  formatDecimal,
  formatHex,
  formatOctal,
  fromNumber,
  hasUnknown,
  logicalAnd,
  logicalNot,
  logicalOr,
  moduloValues,
  multiplyValues,
  reductionAnd,
  reductionOr,
  reductionXor,
  resize,
  shiftLeft,
  shiftRight,
  subtractValues,
  toNumber,
  valueToBinary,
  valueWidth,
} from "./values";

export interface VerilogSourceFile {
  path: string;
  content: string;
}

export interface VerilogSimulationOptions {
  topModule?: string;
  maxTimeNs?: number;
  maxSteps?: number;
  maxSamples?: number;
  maxSignals?: number;
}

export interface VerilogDiagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface VerilogLogEntry {
  timeNs: number;
  kind: "display" | "monitor" | "info" | "error";
  text: string;
}

export interface VerilogSignalInfo {
  path: string;
  label: string;
  width: number;
  depth: number;
}

export interface VerilogSample {
  timeNs: number;
  values: Record<string, FourStateValue>;
}

export interface VerilogSimulationResult {
  ok: boolean;
  topModule: string;
  timeUnitNs: number;
  timeUnitLabel: string;
  hasTimescale: boolean;
  signals: VerilogSignalInfo[];
  samples: VerilogSample[];
  finalValues: Record<string, FourStateValue>;
  log: VerilogLogEntry[];
  diagnostics: VerilogDiagnostic[];
  elapsedTimeNs: number;
  truncated: boolean;
  moduleNames: string[];
  scopeNames: string[];
}

interface SignalSlot {
  path: string;
  name: string;
  width: number;
  msb: bigint;
  lsb: bigint;
  value: FourStateValue;
  kind: "wire" | "reg" | "integer" | "port";
  direction: PortDirection | "internal";
  instance: Instance;
  order: number;
}

interface Instance {
  path: string;
  name: string;
  module: ModuleDeclaration;
  parent: Instance | null;
  slots: Map<string, SignalSlot>;
  parameters: Map<string, bigint>;
  children: Instance[];
  wakeSlots: Set<SignalSlot>;
}

interface MonitorRecord {
  instance: Instance;
  args: Expression[];
  last: string | null;
}

type ProcessState = "ready" | "running" | "waiting" | "scheduled" | "done";

interface EventWait {
  slots: { slot: SignalSlot; edge: Sensitivity["edge"] }[];
  anyChangeIn: Instance | null;
}

interface ProcessRuntime {
  id: number;
  label: string;
  instance: Instance;
  generator: Generator<WaitRequest, void, void>;
  state: ProcessState;
  waitUntil: number | null;
  wait: EventWait | null;
}

type WaitRequest =
  | { kind: "delay"; amount: number }
  | { kind: "event"; wait: EventWait };

interface PendingWrite {
  slot: SignalSlot;
  position: number | null;
  count: number;
  value: FourStateValue;
}

interface SignalChange {
  slot: SignalSlot;
  from: FourStateValue;
  to: FourStateValue;
}

class FinishSignal extends Error {}

const defaultOptions: Required<VerilogSimulationOptions> = {
  topModule: "",
  maxTimeNs: 1_000_000,
  maxSteps: 2_000_000,
  maxSamples: 4_000,
  maxSignals: 24,
};

const timeUnitLabels: Record<string, string> = {
  "1": "s", "1000": "ms", "1000000": "us", "1000000000": "ns", "1000000000000": "ps", "1000000000000000": "fs",
};

function positionOfBit(slot: SignalSlot, bit: bigint, range: SourceRange): number {
  const position = slot.msb >= slot.lsb ? slot.msb - bit : bit - slot.lsb;
  if (position < 0n || position >= BigInt(slot.width)) {
    throw new VerilogError(
      `Bit index ${bit} is out of range for ${slot.name}, which is declared as [${slot.msb}:${slot.lsb}].`,
      range,
    );
  }

  return Number(position);
}

class VerilogSimulator {
  private readonly options: Required<VerilogSimulationOptions>;
  private readonly modules = new Map<string, ModuleDeclaration>();
  private readonly instances: Instance[] = [];
  private readonly processes: ProcessRuntime[] = [];
  private readonly monitors: MonitorRecord[] = [];
  private readonly continuous: { run: () => void }[] = [];
  private readonly queue: ProcessRuntime[] = [];
  private readonly pendingWrites: PendingWrite[] = [];
  private readonly slots: SignalSlot[] = [];
  private readonly aliases: { from: SignalSlot; to: SignalSlot }[] = [];
  private readonly pendingInitializers: { instance: Instance; declarations: Declaration[] }[] = [];
  private readonly log: VerilogLogEntry[] = [];
  private readonly diagnostics: VerilogDiagnostic[] = [];
  private readonly samples: VerilogSample[] = [];
  private readonly lastValues = new Map<SignalSlot, FourStateValue>();
  private captured: SignalSlot[] = [];
  private time = 0;
  private timeUnitNs = 1;
  private timeUnitLabel = "ns";
  private hasTimescale = false;
  private finished = false;
  private truncated = false;
  private slotCounter = 0;
  private topModuleName = "";
  private totalSteps = 0;

  constructor(options: VerilogSimulationOptions = {}) {
    this.options = { ...defaultOptions, ...options };
  }

  run(sources: VerilogSourceFile[]): VerilogSimulationResult {
    try {
      const parsed = parseSources(sources);
      for (const module of parsed.modules) {
        if (this.modules.has(module.name)) {
          throw new VerilogError(`Module “${module.name}” is defined more than once.`, module.ranges);
        }

        this.modules.set(module.name, module);
      }

      if (parsed.timescale) {
        this.timeUnitNs = Math.max(1, Math.round(1_000_000_000 / parsed.timescale.unit));
        this.hasTimescale = true;
      }

      const unit = timeUnitLabels[String(parsed.timescale?.unit ?? 1_000_000_000)] ?? "ns";
      this.timeUnitLabel = this.hasTimescale ? unit : "ns (assumed)";

      this.topModuleName = this.resolveTopModule([...this.modules.keys()]);
      const topModule = this.modules.get(this.topModuleName) as ModuleDeclaration;
      this.elaborate(topModule, "", null, {}, []);
      this.resolveAliases();
      this.buildWakeSets(this.instances[0] as Instance);
      this.captured = this.selectCapturedSignals();
      for (const slot of this.slots) {
        this.lastValues.set(slot, slot.value);
      }

      for (const process of this.processes) {
        this.queue.push(process);
      }

      this.recordSample();
      this.checkMonitors();
      this.schedule();
      return this.buildResult();
    } catch (error) {
      if (error instanceof VerilogError) {
        this.diagnostics.push({
          severity: "error",
          message: error.message,
          file: error.range.file,
          line: error.range.line,
          column: error.range.column,
        });
      } else {
        this.diagnostics.push({ severity: "error", message: error instanceof Error ? error.message : String(error) });
      }

      return this.buildResult();
    }
  }

  private resolveTopModule(names: string[]): string {
    if (this.options.topModule) {
      if (!this.modules.has(this.options.topModule)) {
        throw new VerilogError(
          `Top module “${this.options.topModule}” was not found. Available modules: ${names.join(", ") || "none"}.`,
          { line: 0, column: 0, file: names[0] ?? "" },
        );
      }

      return this.options.topModule;
    }

    if (names.length === 0) {
      throw new VerilogError("No modules were found in the project files.", { line: 0, column: 0, file: "" });
    }

    const instantiated = new Set<string>();
    for (const module of this.modules.values()) {
      for (const instance of module.instances) {
        instantiated.add(instance.moduleName);
      }
    }

    const roots = names.filter((name) => !instantiated.has(name));
    if (roots.length === 1) {
      return roots[0];
    }

    if (roots.length === 0) {
      throw new VerilogError("Every module is instantiated by another module, so there is no top-level module.", { line: 0, column: 0, file: names[0] ?? "" });
    }

    return roots[roots.length - 1];
  }

  private elaborate(module: ModuleDeclaration, path: string, parent: Instance | null, parameterOverrides: Record<string, bigint>, stack: string[]): Instance {
    if (stack.includes(module.name)) {
      throw new VerilogError(`Recursive module instantiation is not supported: ${[...stack, module.name].join(" -> ")}.`, module.ranges);
    }

    if (stack.length > 24) {
      throw new VerilogError("Module instantiation is nested too deeply.", module.ranges);
    }

    const instance: Instance = {
      path,
      name: path === "" ? module.name : (path.split(".").pop() as string),
      module,
      parent,
      slots: new Map(),
      parameters: new Map(),
      children: [],
      wakeSlots: new Set(),
    };

    this.instances.push(instance);
    this.elaborateParameters(instance, parameterOverrides);

    for (const port of module.ports) {
      const range = port.rangeSpec ? this.resolveRange(instance, port.rangeSpec) : null;
      this.addSlot(instance, port.name, port.isReg ? "reg" : "port", port.direction, range);
    }

    for (const declaration of module.declarations) {
      const existing = instance.slots.get(declaration.name);
      if (existing) {
        if (declaration.rangeSpec) {
          const range = this.resolveRange(instance, declaration.rangeSpec);
          existing.width = rangeWidth(range);
          existing.msb = range.msb;
          existing.lsb = range.lsb;
          existing.value = fillValue(existing.width, "x");
        }

        if (declaration.kind === "integer") {
          existing.width = 32;
          existing.msb = 31n;
          existing.lsb = 0n;
          existing.value = fillValue(32, "x");
        }

        continue;
      }

      const range = declaration.rangeSpec
        ? this.resolveRange(instance, declaration.rangeSpec)
        : declaration.kind === "integer" ? { msb: 31n, lsb: 0n } : null;
      this.addSlot(instance, declaration.name, declaration.kind, "internal", range);
    }

    if (module.declarations.some((declaration) => declaration.initializer)) {
      this.pendingInitializers.push({ instance, declarations: module.declarations });
    }

    for (const assign of module.assigns) {
      const expression = assign.value;
      this.continuous.push({
        run: () => {
          const writer = this.resolveWriter(instance, assign.target);
          writer.write(resize(this.evaluate(expression, instance), writer.width));
        },
      });
    }

    for (const primitive of module.primitives) {
      this.continuous.push({ run: () => this.evaluatePrimitive(instance, primitive) });
    }

    this.validateIdentifiers(module, instance);

    for (const child of module.instances) {
      const childModule = this.modules.get(child.moduleName);
      if (!childModule) {
        throw new VerilogError(`Module “${child.moduleName}” is instantiated but never defined.`, child.range);
      }

      const overrides = this.resolveParameterOverrides(child, childModule, instance);
      const childPath = path === "" ? child.name : `${path}.${child.name}`;
      const childInstance = this.elaborate(childModule, childPath, instance, overrides, [...stack, module.name]);
      this.bindConnections(childInstance, child.connections, child.range, instance);
      instance.children.push(childInstance);
    }

    for (const block of module.processes) {
      this.createProcess(block, instance);
    }

    return instance;
  }

  private buildWakeSets(instance: Instance): void {
    instance.wakeSlots.clear();
    for (const slot of instance.slots.values()) {
      instance.wakeSlots.add(slot);
    }

    for (const child of instance.children) {
      this.buildWakeSets(child);
      for (const slot of child.wakeSlots) {
        instance.wakeSlots.add(slot);
      }
    }
  }

  private addSlot(instance: Instance, name: string, kind: SignalSlot["kind"], direction: SignalSlot["direction"], range: VectorRange | null): SignalSlot {
    const msb = range ? range.msb : 0n;
    const lsb = range ? range.lsb : 0n;
    const width = range ? rangeWidth(range) : 1;
    const slot: SignalSlot = {
      path: instance.path === "" ? name : `${instance.path}.${name}`,
      name,
      width,
      msb,
      lsb,
      value: fillValue(width, "x"),
      kind,
      direction,
      instance,
      order: this.slotCounter,
    };

    this.slotCounter += 1;
    instance.slots.set(name, slot);
    this.slots.push(slot);
    return slot;
  }

  private elaborateParameters(instance: Instance, overrides: Record<string, bigint>): void {
    const pending = [...instance.module.parameters];
    let progress = true;
    while (pending.length > 0 && progress) {
      progress = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const declaration = pending[index];
        const value = this.tryEvaluateConstant(declaration.value, instance);
        if (value !== null) {
          instance.parameters.set(declaration.name, value);
          pending.splice(index, 1);
          progress = true;
        }
      }
    }

    if (pending.length > 0) {
      throw new VerilogError(`Parameter “${pending[0].name}” in module “${instance.module.name}” must be a constant expression.`, pending[0].range);
    }

    for (const [name, value] of Object.entries(overrides)) {
      if (!instance.parameters.has(name)) {
        throw new VerilogError(`Module “${instance.module.name}” has no parameter named “${name}”.`, instance.module.ranges);
      }

      instance.parameters.set(name, value);
    }
  }

  private resolveParameterOverrides(instance: { name: string; parameterOverrides: ParameterOverride[]; range: SourceRange }, childModule: ModuleDeclaration, parent: Instance): Record<string, bigint> {
    if (instance.parameterOverrides.length === 0) {
      return {};
    }

    const named = instance.parameterOverrides.some((override) => override.name !== null);
    if (!named && instance.parameterOverrides.length > childModule.parameters.length) {
      throw new VerilogError(
        `Instance “${instance.name}” passes ${instance.parameterOverrides.length} parameter values but “${childModule.name}” declares ${childModule.parameters.length}.`,
        instance.range,
      );
    }

    const overrides: Record<string, bigint> = {};
    instance.parameterOverrides.forEach((override, index) => {
      const parameter = override.name
        ? childModule.parameters.find((candidate) => candidate.name === override.name)
        : childModule.parameters[index];
      if (!parameter) {
        throw new VerilogError(
          `Module “${childModule.name}” has no parameter named “${override.name}”.`,
          override.range,
        );
      }

      const value = this.tryEvaluateConstant(override.value, parent);
      if (value === null) {
        throw new VerilogError("Parameter overrides must be constant expressions.", override.value.range);
      }

      overrides[parameter.name] = value;
    });

    return overrides;
  }

  private resolveRange(instance: Instance, spec: RangeSpec): VectorRange {
    const msb = this.tryEvaluateConstant(spec.msb, instance);
    const lsb = this.tryEvaluateConstant(spec.lsb, instance);
    if (msb === null || lsb === null) {
      throw new VerilogError("Signal ranges must be constant expressions.", spec.range);
    }

    const width = rangeWidth({ msb, lsb });
    if (width <= 0 || width > 4096) {
      throw new VerilogError(`Signal range [${msb}:${lsb}] is not a supported width.`, spec.range);
    }

    return { msb, lsb };
  }

  private resolveTargetSlot(instance: Instance, target: Expression): SignalSlot {
    if (target.kind === "identifier") {
      return this.lookupSlot(instance, target.name, target.range);
    }

    if ((target.kind === "index" || target.kind === "partSelect") && target.target.kind === "identifier") {
      return this.lookupSlot(instance, target.target.name, target.range);
    }

    throw new VerilogError("Only a signal or a bit or part select of a signal can be assigned.", target.range);
  }

  private evaluatePrimitive(instance: Instance, primitive: PrimitiveInstance): void {
    const inverting = primitive.primitive === "not" || primitive.primitive === "buf";
    if (primitive.terminals.length === 0) {
      return;
    }

    const inputCount = inverting && primitive.terminals.length > 1 ? 1 : Math.max(0, primitive.terminals.length - 1);
    const inputTerminals = primitive.terminals.slice(primitive.terminals.length - inputCount);
    const outputTerminals = primitive.terminals.slice(0, primitive.terminals.length - inputCount);
    if (outputTerminals.length === 0) {
      return;
    }

    const inputs = inputTerminals.map((terminal) => this.evaluate(terminal, instance));
    const value = inputs.length === 0 ? fillValue(1, "x") : evaluateGate(primitive.primitive, inputs);
    for (const terminal of outputTerminals) {
      const writer = this.resolveWriter(instance, terminal);
      writer.write(resize(value, writer.width));
    }
  }

  private resolveWriter(instance: Instance, terminal: Expression): { write: (value: FourStateValue) => void; width: number } {
    const slot = this.resolveTargetSlot(instance, terminal);
    if (terminal.kind === "identifier") {
      return { write: (value) => this.writeSlot(slot, value), width: slot.width };
    }

    if (terminal.kind === "index" && terminal.target.kind === "identifier") {
      const bit = this.requireConstant(terminal.index, instance);
      const position = positionOfBit(slot, bit, terminal.range);
      return { write: (value) => this.writeBits(slot, position, value, 1), width: 1 };
    }

    if (terminal.kind === "partSelect" && terminal.target.kind === "identifier") {
      const msb = this.requireConstant(terminal.msb, instance);
      const lsb = this.requireConstant(terminal.lsb, instance);
      const high = Math.min(positionOfBit(slot, msb, terminal.range), positionOfBit(slot, lsb, terminal.range));
      const low = Math.max(positionOfBit(slot, msb, terminal.range), positionOfBit(slot, lsb, terminal.range));
      return { write: (value) => this.writeBits(slot, high, value, low - high + 1), width: low - high + 1 };
    }

    throw new VerilogError("Gate terminals must be signals or bit selects.", terminal.range);
  }

  /**
   * Port connections alias a child's port slot onto a signal in the parent.
   * A child is elaborated before its own port connections are bound, so a
   * grandchild can still be pointing at the child's original slot object.
   * Aliases are recorded while binding and applied here, once the whole
   * hierarchy exists, so that chains like `tb.sum <- dut.sum <- inner.sum`
   * collapse onto a single slot.
   */
  private resolveAliases(): void {
    for (const alias of this.aliases) {
      for (const instance of this.instances) {
        for (const [name, slot] of instance.slots) {
          if (slot === alias.from) {
            instance.slots.set(name, alias.to);
          }
        }
      }

      const index = this.slots.indexOf(alias.from);
      if (index >= 0) {
        if (this.slots.includes(alias.to)) {
          this.slots.splice(index, 1);
        } else {
          this.slots[index] = alias.to;
        }
      }
    }

    for (const pending of this.pendingInitializers) {
      for (const declaration of pending.declarations) {
        if (!declaration.initializer) {
          continue;
        }

        const slot = pending.instance.slots.get(declaration.name);
        if (slot) {
          slot.value = resize(this.evaluate(declaration.initializer, pending.instance), slot.width);
        }
      }
    }
  }

  private bindConnections(child: Instance, connections: { port: string | null; expression: Expression }[], range: SourceRange, parent: Instance): void {
    const ports = child.module.ports;
    connections.forEach((connection, index) => {
      const port = connection.port
        ? ports.find((candidate) => candidate.name === connection.port)
        : ports[index];

      if (!port) {
        throw new VerilogError(
          connection.port
            ? `Module “${child.module.name}” has no port named “${connection.port}”.`
            : `Module “${child.module.name}” has no port at position ${index + 1}.`,
          connection.expression.range,
        );
      }

      const childSlot = child.slots.get(port.name);
      if (!childSlot) {
        return;
      }

      if (connection.expression.kind === "identifier" && parent.slots.has(connection.expression.name)) {
        const parentSlot = parent.slots.get(connection.expression.name) as SignalSlot;
        if (parentSlot.width !== childSlot.width) {
          throw new VerilogError(
            `Port “${port.name}” of “${child.module.name}” is ${childSlot.width} bits wide but ${connection.expression.name} is ${parentSlot.width} bits.`,
            range,
          );
        }

        this.aliases.push({ from: childSlot, to: parentSlot });
        child.slots.set(port.name, parentSlot);
        return;
      }

      const constant = this.tryEvaluateConstant(connection.expression, parent);
      if (constant !== null) {
        const replacement: SignalSlot = { ...childSlot, value: fromNumber(constant, childSlot.width) };
        const index = this.slots.indexOf(childSlot);
        if (index >= 0) {
          this.slots[index] = replacement;
        }

        this.aliases.push({ from: childSlot, to: replacement });
        child.slots.set(port.name, replacement);
        return;
      }

      if (connection.expression.kind !== "identifier") {
        throw new VerilogError("Port connections must name a signal or a constant in this subset.", connection.expression.range);
      }

      const implicit = this.addSlot(parent, connection.expression.name, "wire", "internal", null);
      this.diagnostics.push({
        severity: "warning",
        message: `Implicit 1-bit wire “${connection.expression.name}” was created for an undeclared port connection.`,
        file: connection.expression.range.file,
        line: connection.expression.range.line,
      });
      child.slots.set(port.name, implicit);
    });
  }

  private validateIdentifiers(module: ModuleDeclaration, instance: Instance): void {
    const names = new Set<string>([...instance.slots.keys(), ...instance.parameters.keys()]);
    const fail = (name: string, range: SourceRange): never => {
      throw new VerilogError(`Signal “${name}” is not declared in module “${module.name}”.`, range);
    };

    const visitExpression = (expression: Expression): void => {
      switch (expression.kind) {
        case "identifier":
          if (!names.has(expression.name)) {
            fail(expression.name, expression.range);
          }
          break;
        case "index":
          visitExpression(expression.target);
          visitExpression(expression.index);
          break;
        case "partSelect":
          visitExpression(expression.target);
          visitExpression(expression.msb);
          visitExpression(expression.lsb);
          break;
        case "unary":
          visitExpression(expression.operand);
          break;
        case "binary":
          visitExpression(expression.left);
          visitExpression(expression.right);
          break;
        case "conditional":
          visitExpression(expression.condition);
          visitExpression(expression.whenTrue);
          visitExpression(expression.whenFalse);
          break;
        case "concat":
        case "replicate":
          if (expression.kind === "replicate") {
            visitExpression(expression.count);
          }

          for (const item of expression.items) {
            visitExpression(item);
          }
          break;
        default:
          break;
      }
    };

    const visitStatement = (statement: Statement): void => {
      switch (statement.kind) {
        case "blockingAssign":
        case "nonBlockingAssign":
          visitExpression(statement.target);
          visitExpression(statement.value);
          break;
        case "if":
          visitExpression(statement.condition);
          visitStatement(statement.thenBranch);
          if (statement.elseBranch) {
            visitStatement(statement.elseBranch);
          }
          break;
        case "case":
          visitExpression(statement.condition);
          for (const item of statement.items) {
            for (const expression of item.expressions ?? []) {
              visitExpression(expression);
            }

            visitStatement(item.body);
          }
          break;
        case "for":
          if (statement.initialize) {
            visitStatement(statement.initialize);
          }

          if (statement.condition) {
            visitExpression(statement.condition);
          }

          if (statement.step) {
            visitStatement(statement.step);
          }

          visitStatement(statement.body);
          break;
        case "while":
          visitExpression(statement.condition);
          visitStatement(statement.body);
          break;
        case "repeat":
          visitExpression(statement.count);
          visitStatement(statement.body);
          break;
        case "block":
          for (const item of statement.items) {
            visitStatement(item);
          }
          break;
        case "delay":
          visitExpression(statement.amount);
          if (statement.body) {
            visitStatement(statement.body);
          }
          break;
        case "eventWait":
          if (statement.sensitivity !== "*") {
            for (const item of statement.sensitivity) {
              if (item.expression.kind !== "identifier") {
                throw new VerilogError("Event controls can only watch a single signal name.", item.range);
              }

              visitExpression(item.expression);
            }
          }

          if (statement.body) {
            visitStatement(statement.body);
          }
          break;
        case "systemCall":
          for (const argument of statement.args) {
            if (argument.kind !== "string") {
              visitExpression(argument);
            }
          }
          break;
        default:
          break;
      }
    };

    for (const assign of module.assigns) {
      visitExpression(assign.target);
      visitExpression(assign.value);
    }

    for (const block of module.processes) {
      visitStatement(block.body);
    }
  }

  private createProcess(block: ProcessBlock, instance: Instance): void {
    this.processes.push({
      id: this.processes.length,
      label: `${instance.path === "" ? instance.module.name : instance.path}.${block.kind} line ${block.range.line}`,
      instance,
      generator: this.runProcess(block, instance),
      state: "ready",
      waitUntil: null,
      wait: null,
    });
  }

  private *runProcess(block: ProcessBlock, instance: Instance): Generator<WaitRequest, void, void> {
    if (block.kind === "initial") {
      yield* this.executeStatement(block.body, instance);
      return;
    }

    if (block.sensitivity === null) {
      while (true) {
        yield* this.executeStatement(block.body, instance);
      }
    }

    while (true) {
      yield { kind: "event", wait: this.buildEventWait(block.sensitivity, instance) };
      yield* this.executeStatement(block.body, instance);
    }
  }

  private buildEventWait(sensitivity: Sensitivity[] | "*", instance: Instance): EventWait {
    if (sensitivity === "*") {
      return { slots: [], anyChangeIn: instance };
    }

    const slots = sensitivity.map((item) => {
      if (item.expression.kind !== "identifier") {
        throw new VerilogError("Event controls can only watch a single signal name.", item.range);
      }

      return { slot: this.lookupSlot(instance, item.expression.name, item.range), edge: item.edge };
    });

    return { slots, anyChangeIn: null };
  }

  private *executeStatement(statement: Statement, instance: Instance): Generator<WaitRequest, void, void> {
    switch (statement.kind) {
      case "empty":
        return;
      case "blockingAssign":
        this.assign(instance, statement.target, this.evaluate(statement.value, instance), true);
        return;
      case "nonBlockingAssign":
        this.assign(instance, statement.target, this.evaluate(statement.value, instance), false);
        return;
      case "if": {
        const number = toNumber(this.evaluate(statement.condition, instance));
        if (number === null) {
          this.report("warning", "Condition evaluated to x, so neither branch was taken.", statement.range);
          return;
        }

        const branch = number !== 0n ? statement.thenBranch : statement.elseBranch;
        if (branch) {
          yield* this.executeStatement(branch, instance);
        }
        return;
      }
      case "case": {
        const condition = this.evaluate(statement.condition, instance);
        const matched = this.matchCaseItem(statement, condition, instance);
        if (matched) {
          yield* this.executeStatement(matched, instance);
        }
        return;
      }
      case "for": {
        if (statement.initialize) {
          yield* this.executeStatement(statement.initialize, instance);
        }

        let iterations = 0;
        while (true) {
          if (statement.condition) {
            const number = toNumber(this.evaluate(statement.condition, instance));
            if (number === null || number === 0n) {
              return;
            }
          }

          yield* this.executeStatement(statement.body, instance);
          if (statement.step) {
            yield* this.executeStatement(statement.step, instance);
          }

          iterations += 1;
          if (iterations > 200_000) {
            this.report("error", "A for loop exceeded 200000 iterations and was stopped.", statement.range);
            this.finished = true;
            return;
          }
        }
      }
      case "while": {
        let iterations = 0;
        while (true) {
          const number = toNumber(this.evaluate(statement.condition, instance));
          if (number === null || number === 0n) {
            return;
          }

          yield* this.executeStatement(statement.body, instance);
          iterations += 1;
          if (iterations > 200_000) {
            this.report("error", "A while loop exceeded 200000 iterations and was stopped.", statement.range);
            this.finished = true;
            return;
          }
        }
      }
      case "repeat": {
        const count = toNumber(this.evaluate(statement.count, instance));
        if (count === null || count <= 0n) {
          return;
        }

        for (let index = 0n; index < count; index += 1n) {
          yield* this.executeStatement(statement.body, instance);
        }
        return;
      }
      case "block": {
        for (const item of statement.items) {
          yield* this.executeStatement(item, instance);
        }
        return;
      }
      case "delay": {
        const amount = toNumber(this.evaluate(statement.amount, instance)) ?? 0n;
        yield { kind: "delay", amount: Number(amount) };
        if (statement.body) {
          yield* this.executeStatement(statement.body, instance);
        }
        return;
      }
      case "eventWait": {
        yield { kind: "event", wait: this.buildEventWait(statement.sensitivity, instance) };
        if (statement.body) {
          yield* this.executeStatement(statement.body, instance);
        }
        return;
      }
      case "systemCall":
        this.runSystemCall(statement.name, statement.args, instance, statement.range);
        return;
      default:
        return;
    }
  }

  private matchCaseItem(statement: Extract<Statement, { kind: "case" }>, condition: FourStateValue, instance: Instance): Statement | null {
    for (const item of statement.items) {
      if (!item.expressions) {
        continue;
      }

      for (const expression of item.expressions) {
        const value = this.evaluate(expression, instance);
        const matches = statement.keyword === "casez"
          ? caseInsensitiveMatch(value, condition)
          : equality("===", resize(value, valueWidth(condition)), condition) === digitValue("1");
        if (matches) {
          return item.body;
        }
      }
    }

    const fallback = statement.items.find((item) => item.expressions === null);
    return fallback ? fallback.body : null;
  }

  private runSystemCall(name: string, args: Expression[], instance: Instance, range: SourceRange): void {
    switch (name) {
      case "$display":
        this.appendLog("display", this.formatArguments(args, instance));
        return;
      case "$displayb":
        this.appendLog("display", this.formatArguments(args, instance, "b"));
        return;
      case "$displayh":
        this.appendLog("display", this.formatArguments(args, instance, "h"));
        return;
      case "$write":
        this.appendLog("display", this.formatArguments(args, instance));
        return;
      case "$writeb":
        this.appendLog("display", this.formatArguments(args, instance, "b"));
        return;
      case "$monitor": {
        const record: MonitorRecord = { instance, args, last: null };
        const text = this.formatArguments(args, instance);
        record.last = text;
        this.monitors.push(record);
        this.appendLog("monitor", text);
        return;
      }
      case "$finish":
      case "$stop":
        this.finished = true;
        throw new FinishSignal();
      case "$time":
      case "$realtime":
        this.appendLog("display", String(Math.floor(this.time * this.timeUnitNs)));
        return;
      case "$random":
        throw new VerilogError("$random is not supported in this subset; use a deterministic stimulus instead.", range);
      default:
        throw new VerilogError(`System task “${name}” is not supported in this subset.`, range);
    }
  }

  private formatArguments(args: Expression[], instance: Instance, defaultFormat?: "b" | "h" | "d"): string {
    let output = "";
    let index = 0;

    while (index < args.length) {
      const argument = args[index];
      index += 1;
      if (argument.kind === "string") {
        const expanded = this.expandFormat(argument.value, args, index, instance, defaultFormat);
        output += expanded.text;
        index = expanded.nextIndex;
        continue;
      }

      output += this.formatValue(argument, instance, defaultFormat ?? "d");
    }

    return output;
  }

  private expandFormat(format: string, args: Expression[], startIndex: number, instance: Instance, defaultFormat?: "b" | "h" | "d"): { text: string; nextIndex: number } {
    let output = "";
    let index = 0;
    let argumentIndex = startIndex;
    const pattern = /%(-?)(0?)(\d*)(?:\.(\d+))?([a-zA-Z%])/g;

    while (index < format.length) {
      const character = format[index];
      if (character !== "%") {
        output += character;
        index += 1;
        continue;
      }

      pattern.lastIndex = index;
      const match = pattern.exec(format);
      if (!match) {
        output += character;
        index += 1;
        continue;
      }

      const widthText = match[3] ?? "";
      const conversion = match[5] ?? "";
      index = pattern.lastIndex;
      if (conversion === "%") {
        output += "%";
        continue;
      }

      const argument = args[argumentIndex];
      argumentIndex += 1;
      if (!argument) {
        output += `%${widthText}${conversion}`;
        continue;
      }

      if (conversion === "m") {
        output += instance.path === "" ? instance.module.name : instance.path;
        continue;
      }

      const width = widthText ? Number.parseInt(widthText, 10) : 0;
      output += this.formatValue(argument, instance, conversion || defaultFormat || "d", width);
    }

    return { text: output, nextIndex: argumentIndex };
  }

  private formatValue(argument: Expression, instance: Instance, conversion: string, width = 0): string {
    if (argument.kind === "string") {
      return argument.value;
    }

    const value = this.evaluate(argument, instance);
    const signalWidth = valueWidth(value);
    let text: string;

    switch (conversion) {
      case "b":
        text = valueToBinary(value);
        break;
      case "h":
      case "x":
        text = formatHex(value);
        break;
      case "o":
        text = formatOctal(value);
        break;
      case "c":
        return formatCharacter(value);
      case "t":
        return `${formatDecimal(value)}${this.timeUnitLabel}`;
      case "s": {
        let characters = "";
        for (let offset = 0; offset < signalWidth; offset += 8) {
          characters += formatCharacter(value.slice(offset * 2, offset * 2 + 16));
        }
        return characters;
      }
      case "d":
      default:
        text = formatDecimal(value);
        break;
    }

    if (width > text.length) {
      text = conversion === "b" || conversion === "h" || conversion === "o" || conversion === "x"
        ? text.padStart(width, "0")
        : text.padStart(width, " ");
    }

    return text;
  }

  private assign(instance: Instance, target: Expression, value: FourStateValue, immediate: boolean): void {
    if (target.kind === "identifier") {
      const slot = this.lookupSlot(instance, target.name, target.range);
      this.enqueueWrite({ slot, position: null, count: slot.width, value: resize(value, slot.width) }, immediate);
      return;
    }

    if (target.kind === "index" && target.target.kind === "identifier") {
      const slot = this.lookupSlot(instance, target.target.name, target.range);
      const bit = this.requireConstant(target.index, instance);
      const position = positionOfBit(slot, bit, target.range);
      this.enqueueWrite({ slot, position, count: 1, value: resize(value, 1) }, immediate);
      return;
    }

    if (target.kind === "partSelect" && target.target.kind === "identifier") {
      const slot = this.lookupSlot(instance, target.target.name, target.range);
      const msb = this.requireConstant(target.msb, instance);
      const lsb = this.requireConstant(target.lsb, instance);
      const high = Math.min(positionOfBit(slot, msb, target.range), positionOfBit(slot, lsb, target.range));
      const low = Math.max(positionOfBit(slot, msb, target.range), positionOfBit(slot, lsb, target.range));
      this.enqueueWrite({ slot, position: high, count: low - high + 1, value: resize(value, low - high + 1) }, immediate);
      return;
    }

    throw new VerilogError("Unsupported assignment target.", target.range);
  }

  private enqueueWrite(write: PendingWrite, immediate: boolean): void {
    if (immediate) {
      this.applyWrite(write);
      return;
    }

    this.pendingWrites.push(write);
  }

  private applyWrite(write: PendingWrite): void {
    if (write.position === null) {
      this.writeSlot(write.slot, write.value);
      return;
    }

    this.writeBits(write.slot, write.position, write.value, write.count);
  }

  private writeSlot(slot: SignalSlot, value: FourStateValue): void {
    slot.value = resize(value, slot.width);
  }

  private writeBits(slot: SignalSlot, position: number, value: FourStateValue, count: number): void {
    const incoming = valueToBinary(value);
    let binary = valueToBinary(slot.value);
    for (let offset = 0; offset < count; offset += 1) {
      const target = position + offset;
      if (target < 0 || target >= binary.length) {
        continue;
      }

      binary = binary.slice(0, target) + (incoming[offset] ?? "x") + binary.slice(target + 1);
    }

    slot.value = binaryToValue(binary);
  }

  private evaluate(expression: Expression, instance: Instance): FourStateValue {
    switch (expression.kind) {
      case "number":
        if (expression.digits !== undefined) {
          return binaryToValue(expression.digits);
        }

        return fromNumber(expression.value, expression.width > 0 ? expression.width : 32);
      case "string": {
        if (expression.value.length === 0) {
          return fillValue(8, "0");
        }

        let value = "";
        for (let index = 0; index < Math.min(expression.value.length, 16); index += 1) {
          value += fromNumber(BigInt(expression.value.charCodeAt(index)), 8);
        }
        return value;
      }
      case "identifier": {
        const parameter = instance.parameters.get(expression.name);
        if (parameter !== undefined) {
          return fromNumber(parameter, 32);
        }

        return this.lookupSlot(instance, expression.name, expression.range).value;
      }
      case "index": {
        if (expression.target.kind !== "identifier") {
          throw new VerilogError("Bit selects are only supported on signals.", expression.range);
        }

        const slot = this.lookupSlot(instance, expression.target.name, expression.range);
        const bit = this.requireConstant(expression.index, instance);
        const position = positionOfBit(slot, bit, expression.range);
        return slot.value.slice(position * 2, position * 2 + 2);
      }
      case "partSelect": {
        if (expression.target.kind !== "identifier") {
          throw new VerilogError("Part selects are only supported on signals.", expression.range);
        }

        const slot = this.lookupSlot(instance, expression.target.name, expression.range);
        const msb = this.requireConstant(expression.msb, instance);
        const lsb = this.requireConstant(expression.lsb, instance);
        const high = Math.min(positionOfBit(slot, msb, expression.range), positionOfBit(slot, lsb, expression.range));
        const low = Math.max(positionOfBit(slot, msb, expression.range), positionOfBit(slot, lsb, expression.range));
        return slot.value.slice(high * 2, (low + 1) * 2);
      }
      case "unary": {
        const operand = this.evaluate(expression.operand, instance);
        switch (expression.operator) {
          case "+": return operand;
          case "-": return subtractValues(fromNumber(0n, valueWidth(operand)), operand);
          case "~": return bitwiseNot(operand);
          case "!": return logicalNot(operand);
          case "&": return reductionAnd(operand);
          case "|": return reductionOr(operand);
          case "^": return reductionXor(operand);
          default:
            throw new VerilogError(`Unsupported unary operator “${String((expression as { operator?: string }).operator)}”.`, (expression as { range?: SourceRange }).range ?? { line: 0, column: 0, file: "" });
        }
      }
      case "binary": {
        const left = this.evaluate(expression.left, instance);
        const right = this.evaluate(expression.right, instance);
        switch (expression.operator) {
          case "+": return addValues(left, right);
          case "-": return subtractValues(left, right);
          case "*": return multiplyValues(left, right);
          case "/": return divideValues(left, right);
          case "%": return moduloValues(left, right);
          case "&": return bitwiseAnd(left, right);
          case "|": return bitwiseOr(left, right);
          case "^": return bitwiseXor(left, right);
          case "~^":
          case "^~": return bitwiseXnor(left, right);
          case "<<":
          case "<<<": return shiftLeft(left, toNumber(right) ?? 0n);
          case ">>": return shiftRight(left, toNumber(right) ?? 0n);
          case ">>>": return shiftRight(left, toNumber(right) ?? 0n, true);
          case "<": return compareValues("<", left, right);
          case "<=": return compareValues("<=", left, right);
          case ">": return compareValues(">", left, right);
          case ">=": return compareValues(">=", left, right);
          case "==": return equality("==", left, right);
          case "!=": return equality("!=", left, right);
          case "===": return equality("===", left, right);
          case "!==": return equality("!==", left, right);
          case "&&": return logicalAnd(left, right);
          case "||": return logicalOr(left, right);
          default:
            throw new VerilogError(`Unsupported operator “${String((expression as { operator?: string }).operator)}”.`, (expression as { range?: SourceRange }).range ?? { line: 0, column: 0, file: "" });
        }
      }
      case "conditional": {
        const condition = toNumber(this.evaluate(expression.condition, instance));
        if (condition === null) {
          return fillValue(1, "x");
        }

        const branch = condition !== 0n ? expression.whenTrue : expression.whenFalse;
        const other = condition !== 0n ? expression.whenFalse : expression.whenTrue;
        const width = Math.max(valueWidth(this.evaluate(branch, instance)), valueWidth(this.evaluate(other, instance)));
        return resize(this.evaluate(branch, instance), width);
      }
      case "concat": {
        let value = "";
        for (const item of expression.items) {
          value += this.evaluate(item, instance);
        }
        return value;
      }
      case "replicate": {
        const count = toNumber(this.evaluate(expression.count, instance));
        if (count === null || count < 0n) {
          return fillValue(1, "x");
        }

        let unit = "";
        for (const item of expression.items) {
          unit += this.evaluate(item, instance);
        }

        return unit.repeat(Math.min(Number(count), 4096));
      }
      case "call": {
        if (expression.name === "$time" || expression.name === "$realtime") {
          return fromNumber(BigInt(this.time), 32);
        }

        if (expression.name === "$clog2") {
          const first = expression.args[0];
          const value = first ? toNumber(this.evaluate(first, instance)) ?? 1n : 1n;
          let bits = 0n;
          let remaining = value - 1n;
          while (remaining > 0n) {
            bits += 1n;
            remaining >>= 1n;
          }
          return fromNumber(bits, 32);
        }

        throw new VerilogError(`System function “${expression.name}” is not supported in this subset.`, expression.range);
      }
      default:
        throw new VerilogError("Unsupported expression.", (expression as { range?: SourceRange }).range ?? { line: 0, column: 0, file: "" });
    }
  }

  private requireConstant(expression: Expression, instance: Instance): bigint {
    const value = this.tryEvaluateConstant(expression, instance);
    if (value === null) {
      throw new VerilogError("This index or range must be a constant expression.", expression.range);
    }

    return value;
  }

  private tryEvaluateConstant(expression: Expression, instance: Instance): bigint | null {
    switch (expression.kind) {
      case "number":
        return expression.value;
      case "identifier": {
        const parameter = instance.parameters.get(expression.name);
        if (parameter !== undefined) {
          return parameter;
        }

        const slot = instance.slots.get(expression.name);
        if (slot && slot.kind === "integer" && !hasUnknown(slot.value)) {
          return toNumber(slot.value);
        }

        return null;
      }
      case "unary": {
        const operand = this.tryEvaluateConstant(expression.operand, instance);
        if (operand === null) {
          return null;
        }

        if (expression.operator === "+") {
          return operand;
        }

        if (expression.operator === "-") {
          return -operand;
        }

        if (expression.operator === "~") {
          return ~operand;
        }

        return null;
      }
      case "binary": {
        const left = this.tryEvaluateConstant(expression.left, instance);
        const right = this.tryEvaluateConstant(expression.right, instance);
        if (left === null || right === null) {
          return null;
        }

        switch (expression.operator) {
          case "+": return left + right;
          case "-": return left - right;
          case "*": return left * right;
          case "/": return right === 0n ? null : left / right;
          case "%": return right === 0n ? null : left % right;
          case "<<": return left << right;
          case ">>": return left >> right;
          case "&": return left & right;
          case "|": return left | right;
          case "^": return left ^ right;
          case "~^":
          case "^~": return ~(left ^ right);
          default: return null;
        }
      }
      case "conditional": {
        const condition = this.tryEvaluateConstant(expression.condition, instance);
        if (condition === null) {
          return null;
        }

        return this.tryEvaluateConstant(condition !== 0n ? expression.whenTrue : expression.whenFalse, instance);
      }
      case "concat": {
        let value = 0n;
        for (const item of expression.items) {
          const part = this.tryEvaluateConstant(item, instance);
          if (part === null) {
            return null;
          }

          const width = this.staticWidth(item, instance);
          value = (value << BigInt(width)) | (part & ((1n << BigInt(width)) - 1n));
        }
        return value;
      }
      case "replicate": {
        const count = this.tryEvaluateConstant(expression.count, instance);
        if (count === null || count < 0n) {
          return null;
        }

        let value = 0n;
        for (const item of expression.items) {
          const part = this.tryEvaluateConstant(item, instance);
          if (part === null) {
            return null;
          }

          value = (value << BigInt(this.staticWidth(item, instance))) | part;
        }

        return value * count;
      }
      default:
        return null;
    }
  }

  private staticWidth(expression: Expression, instance: Instance): number {
    switch (expression.kind) {
      case "number":
        return expression.width > 0 ? expression.width : 32;
      case "identifier":
        return instance.slots.get(expression.name)?.width ?? 32;
      case "concat":
      case "replicate":
        return expression.items.reduce((total, item) => total + this.staticWidth(item, instance), 0);
      case "partSelect": {
        if (expression.target.kind !== "identifier") {
          return 1;
        }

        if (!instance.slots.has(expression.target.name)) {
          return 1;
        }

        const msb = this.tryEvaluateConstant(expression.msb, instance);
        const lsb = this.tryEvaluateConstant(expression.lsb, instance);
        return msb === null || lsb === null ? 1 : rangeWidth({ msb, lsb });
      }
      case "unary":
        return this.staticWidth(expression.operand, instance);
      case "binary":
        return Math.max(this.staticWidth(expression.left, instance), this.staticWidth(expression.right, instance));
      case "conditional":
        return Math.max(this.staticWidth(expression.whenTrue, instance), this.staticWidth(expression.whenFalse, instance));
      case "index":
        return 1;
      default:
        return 1;
    }
  }

  private lookupSlot(instance: Instance, name: string, range: SourceRange): SignalSlot {
    const slot = instance.slots.get(name);
    if (!slot) {
      throw new VerilogError(`Signal “${name}” is not declared in module “${instance.module.name}”.`, range);
    }

    return slot;
  }

  private schedule(): void {
    while (!this.finished) {
      this.totalSteps += 1;
      if (this.totalSteps > this.options.maxSteps) {
        this.diagnostics.push({
          severity: "error",
          message: `Simulation stopped after ${this.options.maxSteps} steps. Check for a combinational loop or a testbench without $finish.`,
        });
        break;
      }

      if (this.time > this.options.maxTimeNs) {
        this.diagnostics.push({
          severity: "error",
          message: `Simulation stopped after ${this.options.maxTimeNs} time units. Shorten the testbench or add $finish.`,
        });
        break;
      }

      const process = this.queue.shift();
      if (process) {
        this.stepProcess(process);
        this.propagate(false);
        continue;
      }

      this.propagate(true);
      if (this.queue.length > 0) {
        continue;
      }

      const next = this.earliestScheduledTime();
      if (next === null) {
        this.diagnostics.push({
          severity: "warning",
          message: "No more events: every process is waiting forever. Add a clock generator or $finish to the testbench.",
        });
        break;
      }

      this.time = next;
      for (const candidate of this.processes) {
        if (candidate.state === "scheduled" && candidate.waitUntil === next) {
          candidate.state = "ready";
          candidate.waitUntil = null;
          this.queue.push(candidate);
        }
      }
    }

    this.applyPendingWrites();
    this.propagate(true);
  }

  private stepProcess(process: ProcessRuntime): void {
    if (process.state !== "ready") {
      return;
    }

    process.state = "running";
    let result: IteratorResult<WaitRequest, void>;
    try {
      result = process.generator.next();
    } catch (error) {
      process.state = "done";
      if (error instanceof FinishSignal) {
        return;
      }

      throw error;
    }



    if (result.done) {
      process.state = "done";
      return;
    }

    const request = result.value;
    if (request.kind === "delay") {
      process.state = "scheduled";
      process.waitUntil = this.time + Math.max(0, Math.round(request.amount));
      return;
    }

    process.state = "waiting";
    process.wait = request.wait;
  }

  private propagate(applyPending: boolean): void {
    for (let iteration = 0; iteration < 1024; iteration += 1) {
      if (applyPending) {
        this.applyPendingWrites();
      }

      const changes = this.detectChanges();
      if (changes.length > 0) {
        this.wakeWaiters(changes);
        this.recordSample();
        this.checkMonitors();
      }

      const before = this.slots.map((slot) => slot.value);
      for (const item of this.continuous) {
        item.run();
      }

      let settled = true;
      for (let index = 0; index < this.slots.length; index += 1) {
        if (this.slots[index]?.value !== before[index]) {
          settled = false;
          break;
        }
      }

      if (settled) {
        return;
      }
    }

    this.diagnostics.push({
      severity: "error",
      message: "Combinational settling did not converge. Check for a feedback loop between continuous assignments or gate primitives.",
    });
  }

  private applyPendingWrites(): void {
    if (this.pendingWrites.length === 0) {
      return;
    }

    const pending = this.pendingWrites.splice(0, this.pendingWrites.length);
    for (const write of pending) {
      this.applyWrite(write);
    }
  }

  private detectChanges(): SignalChange[] {
    const changes: SignalChange[] = [];
    for (const slot of this.slots) {
      const previous = this.lastValues.get(slot) ?? slot.value;
      if (previous !== slot.value) {
        this.lastValues.set(slot, slot.value);
        changes.push({ slot, from: previous, to: slot.value });
      }
    }

    return changes;
  }

  private earliestScheduledTime(): number | null {
    let earliest: number | null = null;
    for (const process of this.processes) {
      if (process.state !== "scheduled" || process.waitUntil === null) {
        continue;
      }

      if (earliest === null || process.waitUntil < earliest) {
        earliest = process.waitUntil;
      }
    }

    return earliest;
  }

  private wakeWaiters(changes: SignalChange[]): void {
    for (const process of this.processes) {
      if (process.state !== "waiting" || !process.wait) {
        continue;
      }

      const wait = process.wait;
      const anyChangeIn = wait.anyChangeIn;
      const triggered = anyChangeIn
        ? changes.some((change) => anyChangeIn.wakeSlots.has(change.slot))
        : wait.slots.some((entry) => changes.some((change) => change.slot === entry.slot && edgeMatches(entry.edge, change.from, change.to)));

      if (triggered) {
        process.state = "ready";
        process.wait = null;
        this.queue.push(process);
      }
    }
  }

  private checkMonitors(): void {
    for (const monitor of this.monitors) {
      const text = this.formatArguments(monitor.args, monitor.instance);
      if (text !== monitor.last) {
        monitor.last = text;
        this.appendLog("monitor", text);
      }
    }
  }

  private appendLog(kind: VerilogLogEntry["kind"], text: string): void {
    this.log.push({ timeNs: Math.round(this.time * this.timeUnitNs), kind, text });
    if (this.log.length > 5000) {
      this.log.splice(0, this.log.length - 5000);
    }
  }

  private report(severity: "error" | "warning", message: string, range: SourceRange): void {
    this.diagnostics.push({ severity, message, file: range.file, line: range.line, column: range.column });
  }

  private selectCapturedSignals(): SignalSlot[] {
    const sorted = [...this.slots].sort((left, right) => {
      const leftDepth = left.instance.path === "" ? 0 : left.instance.path.split(".").length;
      const rightDepth = right.instance.path === "" ? 0 : right.instance.path.split(".").length;
      return leftDepth === rightDepth ? left.order - right.order : leftDepth - rightDepth;
    });

    const captured = sorted.slice(0, this.options.maxSignals);
    if (sorted.length > captured.length) {
      this.diagnostics.push({
        severity: "warning",
        message: `The waveform shows the first ${captured.length} signals; this design has ${sorted.length}.`,
      });
    }

    return captured;
  }

  private recordSample(): void {
    if (this.samples.length >= this.options.maxSamples) {
      if (!this.truncated) {
        this.truncated = true;
        this.diagnostics.push({
          severity: "warning",
          message: `Waveform capture stopped at ${this.options.maxSamples} samples to keep the browser responsive.`,
        });
      }
      return;
    }

    const values: Record<string, FourStateValue> = {};
    for (const slot of this.captured) {
      values[slot.path] = slot.value;
    }

    this.samples.push({ timeNs: Math.round(this.time * this.timeUnitNs), values });
  }

  private buildResult(): VerilogSimulationResult {
    const finalValues: Record<string, FourStateValue> = {};
    for (const slot of this.captured) {
      finalValues[slot.path] = slot.value;
    }

    return {
      ok: !this.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      topModule: this.topModuleName,
      timeUnitNs: this.timeUnitNs,
      timeUnitLabel: this.timeUnitLabel,
      hasTimescale: this.hasTimescale,
      signals: this.captured.map((slot) => ({
        path: slot.path,
        label: slot.path,
        width: slot.width,
        depth: slot.instance.path === "" ? 0 : slot.instance.path.split(".").length,
      })),
      samples: this.samples,
      finalValues,
      log: this.log,
      diagnostics: this.diagnostics,
      elapsedTimeNs: Math.round(this.time * this.timeUnitNs),
      truncated: this.truncated,
      moduleNames: [...this.modules.keys()],
      scopeNames: this.instances.filter((instance) => instance.path !== "").map((instance) => instance.path),
    };
  }
}

function edgeMatches(edge: Sensitivity["edge"], from: FourStateValue, to: FourStateValue): boolean {
  if (from === to) {
    return false;
  }

  if (edge === "posedge") {
    return to === digitValue("1") && from !== digitValue("1");
  }

  if (edge === "negedge") {
    return to === digitValue("0") && from !== digitValue("0");
  }

  return true;
}

function caseInsensitiveMatch(item: FourStateValue, condition: FourStateValue): boolean {
  const width = Math.max(valueWidth(item), valueWidth(condition));
  const left = resize(item, width);
  const right = resize(condition, width);
  for (let position = 0; position < width; position += 1) {
    const itemDigit = digitAt(left, position);
    const conditionDigit = digitAt(right, position);
    if (itemDigit === "x" || itemDigit === "z") {
      continue;
    }

    if (itemDigit !== conditionDigit) {
      return false;
    }
  }

  return true;
}

export function simulateVerilog(sources: VerilogSourceFile[], options: VerilogSimulationOptions = {}): VerilogSimulationResult {
  return new VerilogSimulator(options).run(sources);
}
