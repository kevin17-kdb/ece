import { getComponentDefinition, pinNodeId, unitStateKey, type CircuitUnitDefinition } from "./circuitCatalog";
import type { CircuitComponent, CircuitDocument, DigitalValue } from "../types/project";

export interface SimulationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
}

export interface UnitState {
  bits: string;
  clock: DigitalValue;
}

export interface SimulationState {
  units: Record<string, UnitState>;
}

export interface DisplayState {
  glyph: string;
  segments: Record<string, boolean>;
  unknown: boolean;
}

export interface DigitalSimulationResult {
  nodeValues: Record<string, DigitalValue>;
  componentValues: Record<string, DigitalValue>;
  unitValues: Record<string, DigitalValue>;
  displays: Record<string, DisplayState>;
  state: SimulationState;
  issues: SimulationIssue[];
}

const segmentOrder = ["a", "b", "c", "d", "e", "f", "g"] as const;

const digitPatterns: Record<string, string> = {
  0: "1111110",
  1: "0110000",
  2: "1101101",
  3: "1111001",
  4: "0110011",
  5: "1011011",
  6: "1011111",
  7: "1110000",
  8: "1111111",
  9: "1111011",
  a: "1110111",
  b: "0011111",
  c: "1100110",
  d: "1011011",
  e: "1001111",
  f: "1000111",
};

const glyphByPattern: Record<string, string> = Object.fromEntries(
  Object.entries(digitPatterns).map(([glyph, pattern]) => [pattern, glyph.toUpperCase()]),
);

function patternToSegments(pattern: string): Record<string, boolean> {
  return Object.fromEntries(segmentOrder.map((segment, index) => [segment, pattern[index] === "1"]));
}

function getPin(component: CircuitComponent, pinId: string) {
  return component.pins.find((pin) => pin.id === pinId);
}

function findNet(document: CircuitDocument, nodeId: string) {
  return document.nets.find((net) => net.nodeIds.includes(nodeId));
}

function resolveNetValue(
  document: CircuitDocument,
  netId: string,
  pinValues: Map<string, DigitalValue>,
  issues: SimulationIssue[],
): DigitalValue {
  const net = document.nets.find((candidate) => candidate.id === netId);
  if (!net) {
    return "x";
  }

  const driverValues = net.nodeIds
    .map((connectedNodeId) => {
      const [componentId, pinId] = connectedNodeId.split(":");
      const component = document.components.find((candidate) => candidate.id === componentId);
      const pin = component && pinId ? getPin(component, pinId) : undefined;
      if (!component || !pin || pin.direction !== "output") {
        return undefined;
      }

      return pinValues.get(connectedNodeId);
    })
    .filter((value): value is DigitalValue => value !== undefined);

  if (driverValues.length === 0) {
    return "x";
  }

  const resolved = driverValues.filter((value) => value === "0" || value === "1");
  if (resolved.length !== driverValues.length) {
    return "x";
  }

  if (resolved.length > 1 && new Set(resolved).size > 1) {
    if (!issues.some((issue) => issue.code === "DRIVER_CONFLICT" && issue.nodeId === net.id)) {
      issues.push({
        severity: "error",
        code: "DRIVER_CONFLICT",
        message: `Net ${net.name} has conflicting output drivers.`,
        nodeId: net.id,
      });
    }
    return "x";
  }

  return resolved[0] ?? "x";
}

function getInputValue(
  document: CircuitDocument,
  nodeId: string,
  pinValues: Map<string, DigitalValue>,
  issues: SimulationIssue[],
): DigitalValue {
  const net = findNet(document, nodeId);
  if (!net) {
    return "x";
  }

  return resolveNetValue(document, net.id, pinValues, issues);
}

function evaluateGate(type: string, inputs: DigitalValue[]): DigitalValue {
  const [a, b] = inputs;
  const normalize = (value: DigitalValue | undefined): DigitalValue => value ?? "x";

  if (type === "not") {
    const input = normalize(a);
    if (input === "0") {
      return "1";
    }
    if (input === "1") {
      return "0";
    }
    return "x";
  }

  if (type === "buffer") {
    return normalize(a);
  }

  if (type === "and" || type === "nand") {
    if (a === "0" || b === "0") {
      return type === "and" ? "0" : "1";
    }
    if (a === "1" && b === "1") {
      return type === "and" ? "1" : "0";
    }
    return "x";
  }

  if (type === "or" || type === "nor") {
    if (a === "1" || b === "1") {
      return type === "or" ? "1" : "0";
    }
    if (a === "0" && b === "0") {
      return type === "or" ? "0" : "1";
    }
    return "x";
  }

  if (type === "xor" || type === "xnor") {
    if (a === "0" || a === "1") {
      if (b === "0" || b === "1") {
        const equal = a === b;
        return type === "xnor" ? (equal ? "1" : "0") : (equal ? "0" : "1");
      }
    }
    return "x";
  }

  return "x";
}

function sourceValue(component: CircuitComponent): DigitalValue {
  if (component.type === "vcc") {
    return "1";
  }

  if (component.type === "gnd") {
    return "0";
  }

  if (component.value === "0" || component.value === "1") {
    return component.value;
  }

  return "x";
}

function invert(value: DigitalValue): DigitalValue {
  if (value === "0") {
    return "1";
  }

  if (value === "1") {
    return "0";
  }

  return "x";
}

function initialBits(unit: CircuitUnitDefinition): string {
  return "0".repeat(unit.stateWidth ?? 1);
}

function bitsToValue(bits: string): number {
  return Number.parseInt([...bits].reverse().join(""), 2);
}

function valueToBits(value: number, width: number): string {
  return value.toString(2).padStart(width, "0").split("").reverse().join("");
}

function isEdge(previous: DigitalValue, current: DigitalValue, edge: "rising" | "falling"): boolean {
  if (edge === "rising") {
    return previous === "0" && current === "1";
  }

  return previous === "1" && current === "0";
}

interface UnitContext {
  document: CircuitDocument;
  component: CircuitComponent;
  unit: CircuitUnitDefinition;
  pinValues: Map<string, DigitalValue>;
  issues: SimulationIssue[];
  powered: boolean;
}

type UnitEvaluation = {
  outputs: Record<string, DigitalValue>;
  value: DigitalValue;
  bits: string;
  clock: DigitalValue;
};

function readPinValue(context: UnitContext, pinId: string): DigitalValue {
  return getInputValue(context.document, pinNodeId(context.component.id, pinId), context.pinValues, context.issues);
}

function evaluateBcdDecoder(context: UnitContext, previous: UnitState): UnitEvaluation {
  const { unit } = context;
  const bitValue = (pinId: string, weight: number): number | null => {
    const value = readPinValue(context, pinId);
    if (value !== "0" && value !== "1") {
      return null;
    }

    return value === "1" ? weight : 0;
  };

  const a = bitValue("a", 1);
  const b = bitValue("b", 2);
  const c = bitValue("c", 4);
  const d = bitValue("d", 8);
  const lampTest = readPinValue(context, "lt");
  const rippleBlankInput = readPinValue(context, "rbi");
  const outputs: Record<string, DigitalValue> = {};

  if (a === null || b === null || c === null || d === null) {
    for (const pinId of unit.outputPinIds) {
      outputs[pinId] = "x";
    }

    return { outputs, value: "x", bits: previous.bits, clock: previous.clock };
  }

  const code = a + b + c + d;
  const segments = patternToSegments(digitPatterns[code] ?? "0000000");
  let lit: Record<string, boolean> = segments;
  let rbo: "0" | "1" = "1";

  if (lampTest === "0") {
    lit = Object.fromEntries(segmentOrder.map((segment) => [segment, true]));
  } else if (rippleBlankInput === "0" && code === 0) {
    lit = Object.fromEntries(segmentOrder.map((segment) => [segment, false]));
    rbo = "0";
  }

  for (const pinId of unit.outputPinIds) {
    if (pinId === "rbo") {
      outputs[pinId] = rbo;
      continue;
    }

    const segmentName = pinId.replace("_out", "");
    outputs[pinId] = lit[segmentName] ? "0" : "1";
  }

  const resolvedOutputs = unit.outputPinIds.filter((pinId) => pinId !== "rbo").map((pinId) => outputs[pinId]);
  const value = new Set(resolvedOutputs).size === 1 ? resolvedOutputs[0] ?? "x" : "x";
  return { outputs, value, bits: previous.bits, clock: previous.clock };
}

function evaluateUnit(context: UnitContext, previous: UnitState): UnitEvaluation {
  const { unit } = context;

  if (!context.powered) {
    return {
      outputs: Object.fromEntries(unit.outputPinIds.map((pinId) => [pinId, "z" as DigitalValue])),
      value: "z",
      bits: previous.bits,
      clock: previous.clock,
    };
  }

  if (unit.kind === "bcd7seg") {
    return evaluateBcdDecoder(context, previous);
  }

  if (unit.kind === "gate") {
    const inputs = unit.inputPinIds.map((pinId) => readPinValue(context, pinId));
    const value = evaluateGate(unit.gateType ?? "and", inputs);
    return {
      outputs: Object.fromEntries(unit.outputPinIds.map((pinId) => [pinId, value])),
      value,
      bits: previous.bits,
      clock: previous.clock,
    };
  }

  const clockPinId = unit.clockPinIds?.[0];
  const clock = clockPinId ? readPinValue(context, clockPinId) : "x";
  const edge = isEdge(previous.clock, clock, unit.edge ?? "rising");

  if (unit.kind === "dff") {
    const dataPinId = unit.inputPinIds[0] ?? "";
    const setPinId = unit.setPinIds?.[0];
    const clearPinId = unit.clearPinIds?.[0];
    const setValue = setPinId ? readPinValue(context, setPinId) : "1";
    const clearValue = clearPinId ? readPinValue(context, clearPinId) : "1";
    let bits = previous.bits;

    if (clearValue === (unit.clearActiveLevel ?? "0")) {
      bits = "0";
    } else if (setValue === (unit.setActiveLevel ?? "1")) {
      bits = "1";
    } else if (edge) {
      const data = readPinValue(context, dataPinId);
      bits = data === "0" || data === "1" ? data : previous.bits;
    }

    const output = bits === "0" ? "0" : bits === "1" ? "1" : "x";
    return {
      outputs: Object.fromEntries(unit.outputPinIds.map((pinId) => [pinId, pinId.endsWith("b") ? invert(output) : output])),
      value: output,
      bits,
      clock,
    };
  }

  if (unit.kind === "counter4") {
    const clearPinId = unit.clearPinIds?.[0];
    const clearValue = clearPinId ? readPinValue(context, clearPinId) : "0";
    const width = unit.stateWidth ?? 4;
    let bits = previous.bits || initialBits(unit);

    if (clearValue === (unit.clearActiveLevel ?? "1")) {
      bits = initialBits(unit);
    } else if (edge) {
      bits = valueToBits((bitsToValue(bits) + 1) % (2 ** width), width);
    }

    const outputs = Object.fromEntries(unit.outputPinIds.map((pinId, index) => [pinId, (bits[index] ?? "x") as DigitalValue]));
    const value = new Set(Object.values(outputs)).size === 1 ? Object.values(outputs)[0] ?? "x" : "x";
    return { outputs, value, bits, clock };
  }

  return {
    outputs: Object.fromEntries(unit.outputPinIds.map((pinId) => [pinId, "x" as DigitalValue])),
    value: "x",
    bits: previous.bits,
    clock,
  };
}

function checkPower(
  document: CircuitDocument,
  component: CircuitComponent,
  pinValues: Map<string, DigitalValue>,
  issues: SimulationIssue[],
): boolean {
  const powerPins = component.pins.filter((pin) => pin.direction === "power");
  if (powerPins.length === 0) {
    return true;
  }

  let powered = true;
  for (const pin of powerPins) {
    const expected: DigitalValue = pin.name.toUpperCase().includes("GND") ? "0" : "1";
    const net = findNet(document, pinNodeId(component.id, pin.id));

    if (!net) {
      powered = false;
      issues.push({
        severity: "error",
        code: "POWER_NOT_CONNECTED",
        message: `${component.label} pin ${pin.number} (${pin.name}) is not connected to a supply.`,
        nodeId: pinNodeId(component.id, pin.id),
      });
      continue;
    }

    const actual = resolveNetValue(document, net.id, pinValues, issues);
    if (actual !== expected) {
      powered = false;
      issues.push({
        severity: "error",
        code: "POWER_OUT_OF_RANGE",
        message: `${component.label} pin ${pin.number} (${pin.name}) expects ${expected} but net ${net.name} is ${actual.toUpperCase()}.`,
        nodeId: pinNodeId(component.id, pin.id),
      });
    }
  }

  return powered;
}

export function simulateDigitalCircuit(
  document: CircuitDocument,
  options: { initialState?: SimulationState } = {},
): DigitalSimulationResult {
  const issues: SimulationIssue[] = [];
  const pinValues = new Map<string, DigitalValue>();
  const componentValues: Record<string, DigitalValue> = {};
  const unitValues: Record<string, DigitalValue> = {};
  const displays: Record<string, DisplayState> = {};
  const state: SimulationState = { units: { ...(options.initialState?.units ?? {}) } };
  const sourceTypes = ["switch", "clock", "vcc", "gnd"];
  const primitiveGates = ["and", "or", "not", "nand", "nor", "xor", "xnor", "buffer"];

  for (const component of document.components) {
    for (const pin of component.pins) {
      pinValues.set(pinNodeId(component.id, pin.id), "x");
    }
  }

  for (const component of document.components) {
    if (!sourceTypes.includes(component.type)) {
      continue;
    }

    const value = sourceValue(component);
    componentValues[component.id] = value;
    for (const pin of component.pins) {
      if (pin.direction === "output" || pin.direction === "power") {
        pinValues.set(pinNodeId(component.id, pin.id), value);
      }
    }
  }

  const powerStatus = new Map<string, boolean>();
  for (const component of document.components) {
    const definition = getComponentDefinition(component.type);
    if (definition?.units && definition.units.length > 0) {
      powerStatus.set(component.id, checkPower(document, component, pinValues, issues));
    } else {
      powerStatus.set(component.id, true);
    }
  }

  const maxIterations = Math.max(document.components.length * 3, 4);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false;

    for (const component of document.components) {
      const definition = getComponentDefinition(component.type);

      if (!definition) {
        issues.push({
          severity: "error",
          code: "UNKNOWN_COMPONENT",
          message: `No simulation model is registered for ${component.type}.`,
        });
        continue;
      }

      if (sourceTypes.includes(component.type)) {
        continue;
      }

      if (primitiveGates.includes(component.type)) {
        const inputPins = component.pins.filter((pin) => pin.direction === "input");
        const inputValues = inputPins.map((pin) => getInputValue(document, pinNodeId(component.id, pin.id), pinValues, issues));
        const output = evaluateGate(component.type, inputValues);
        componentValues[component.id] = output;
        const outputPin = component.pins.find((pin) => pin.direction === "output");
        if (outputPin) {
          const outputNodeId = pinNodeId(component.id, outputPin.id);
          if (pinValues.get(outputNodeId) !== output) {
            pinValues.set(outputNodeId, output);
            changed = true;
          }
        }
        continue;
      }

      if (definition.units && definition.units.length > 0) {
        const unitValuesForComponent: DigitalValue[] = [];
        for (const unit of definition.units) {
          const key = unitStateKey(component.id, unit.id);
          const previous = state.units[key] ?? { bits: initialBits(unit), clock: "x" as DigitalValue };
          const evaluation = evaluateUnit({
            document,
            component,
            unit,
            pinValues,
            issues,
            powered: powerStatus.get(component.id) ?? true,
          }, previous);
          state.units[key] = { bits: evaluation.bits, clock: evaluation.clock };
          unitValues[key] = evaluation.value;

          for (const [pinId, value] of Object.entries(evaluation.outputs)) {
            const nodeId = pinNodeId(component.id, pinId);
            if (pinValues.get(nodeId) !== value) {
              pinValues.set(nodeId, value);
              changed = true;
            }
          }

          unitValuesForComponent.push(evaluation.value);
        }

        const distinct = new Set(unitValuesForComponent);
        componentValues[component.id] = distinct.size === 1 ? unitValuesForComponent[0] ?? "x" : "x";
        continue;
      }

      if (component.type === "led" || component.type === "probe") {
        const inputPin = component.pins.find((pin) => pin.direction === "input");
        componentValues[component.id] = inputPin ? getInputValue(document, pinNodeId(component.id, inputPin.id), pinValues, issues) : "x";
        continue;
      }

      if (component.type === "display7") {
        const activeLevel: DigitalValue = component.parameters?.anode === "anode" ? "0" : "1";
        const segments: Record<string, boolean> = {};
        let unknown = false;
        for (const pin of component.pins) {
          const value = getInputValue(document, pinNodeId(component.id, pin.id), pinValues, issues);
          if (value !== "0" && value !== "1") {
            segments[pin.id] = false;
            if (pin.id !== "dp") {
              unknown = true;
            }
            continue;
          }

          segments[pin.id] = value === activeLevel;
        }

        const pattern = segmentOrder.map((segment) => (segments[segment] ? "1" : "0")).join("");
        displays[component.id] = {
          glyph: unknown ? "?" : glyphByPattern[pattern] ?? " ",
          segments,
          unknown,
        };
        componentValues[component.id] = Object.values(segments).some(Boolean) ? "1" : "0";
      }
    }

    if (!changed) {
      break;
    }
  }

  for (const component of document.components) {
    if (!componentValues[component.id]) {
      componentValues[component.id] = "x";
    }

    for (const pin of component.pins) {
      if (pin.direction === "input" && !findNet(document, pinNodeId(component.id, pin.id))) {
        issues.push({
          severity: "warning",
          code: "FLOATING_INPUT",
          message: `${component.label} pin ${pin.name} is not connected.`,
          nodeId: pinNodeId(component.id, pin.id),
        });
      }
    }
  }

  for (const net of document.nets) {
    const netValue = resolveNetValue(document, net.id, pinValues, issues);
    for (const nodeId of net.nodeIds) {
      pinValues.set(nodeId, netValue);
    }
  }

  const nodeValues: Record<string, DigitalValue> = {};
  for (const [nodeId, value] of pinValues.entries()) {
    nodeValues[nodeId] = value;
  }

  return { nodeValues, componentValues, unitValues, displays, state, issues };
}

export function formatDigitalValue(value: DigitalValue | undefined): string {
  if (value === "0" || value === "1") {
    return value;
  }

  return "X";
}
