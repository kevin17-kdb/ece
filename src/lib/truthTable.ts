import { setComponentValue } from "./circuitOperations";
import { simulateDigitalCircuit } from "./digitalSimulation";
import type { CircuitComponent, CircuitDocument, DigitalValue } from "../types/project";

export interface TruthTableColumn {
  id: string;
  label: string;
}

export interface TruthTableRow {
  inputs: DigitalValue[];
  outputs: string[];
}

export interface TruthTableResult {
  inputs: TruthTableColumn[];
  outputs: TruthTableColumn[];
  rows: TruthTableRow[];
  truncated: boolean;
}

/**
 * Enumerates every combination of the circuit's input sources and records the
 * resulting output values using the real digital simulator. Returns null when
 * the schematic has no suitable inputs or too many to enumerate.
 */
export function buildTruthTable(
  document: CircuitDocument,
  options: { maxInputs?: number; maxRows?: number } = {},
): TruthTableResult | null {
  const maxInputs = options.maxInputs ?? 8;
  const maxRows = options.maxRows ?? 256;

  const inputComponents = document.components.filter((component) => component.type === "switch" || component.type === "clock");
  if (inputComponents.length === 0 || inputComponents.length > maxInputs) {
    return null;
  }

  const indicators = document.components.filter(
    (component) => component.type === "led" || component.type === "probe" || component.type === "display7",
  );
  const outputComponents =
    indicators.length > 0
      ? indicators
      : document.components.filter(
          (component) =>
            !inputComponents.includes(component) &&
            component.type !== "vcc" &&
            component.type !== "gnd" &&
            component.pins.some((pin) => pin.direction === "output"),
        );

  if (outputComponents.length === 0) {
    return null;
  }

  const total = 2 ** inputComponents.length;
  const rows: TruthTableRow[] = [];

  for (let index = 0; index < total && rows.length < maxRows; index += 1) {
    let current = document;
    const inputValues: DigitalValue[] = [];

    inputComponents.forEach((component, bit) => {
      const value: DigitalValue = (index >> (inputComponents.length - 1 - bit)) & 1 ? "1" : "0";
      inputValues.push(value);
      current = setComponentValue(current, component.id, value);
    });

    const result = simulateDigitalCircuit(current);
    const outputs = outputComponents.map((component) => readOutput(component, result.componentValues, result.displays));
    rows.push({ inputs: inputValues, outputs });
  }

  return {
    inputs: inputComponents.map((component) => ({ id: component.id, label: component.label })),
    outputs: outputComponents.map((component) => ({ id: component.id, label: component.label })),
    rows,
    truncated: total > rows.length,
  };
}

function readOutput(
  component: CircuitComponent,
  componentValues: Record<string, DigitalValue>,
  displays: Record<string, { glyph: string }>,
): string {
  if (component.type === "display7") {
    return displays[component.id]?.glyph ?? "?";
  }

  return componentValues[component.id] ?? "x";
}
