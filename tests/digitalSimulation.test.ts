import { describe, expect, it } from "vitest";
import { createCircuitComponent, pinNodeId } from "../src/lib/circuitCatalog";
import { connectPins, createExampleCircuit } from "../src/lib/circuitOperations";
import { simulateDigitalCircuit } from "../src/lib/digitalSimulation";
import type { CircuitDocument, DigitalValue } from "../src/types/project";

function gateCircuit(type: string, a: DigitalValue, b?: DigitalValue): CircuitDocument {
  const inputA = createCircuitComponent("switch", { x: 0, y: 0 }, `input-a-${type}`);
  const inputB = createCircuitComponent("switch", { x: 0, y: 100 }, `input-b-${type}`);
  const gate = createCircuitComponent(type, { x: 180, y: 40 }, `gate-${type}`);
  const components = [inputA, inputB, gate].map((component) => component.id === inputA.id ? { ...component, value: a } : component.id === inputB.id ? { ...component, value: b ?? "0" } : component);
  const nets = [
    { id: `net-a-${type}`, name: "A", nodeIds: [pinNodeId(inputA.id, "out"), pinNodeId(gate.id, "a")] },
  ];
  const gatePins = gate.pins.filter((pin) => pin.direction === "input");
  if (gatePins[1]) {
    nets.push({ id: `net-b-${type}`, name: "B", nodeIds: [pinNodeId(inputB.id, "out"), pinNodeId(gate.id, gatePins[1].id)] });
  }

  return { components, nets, gridSize: 20 };
}

describe("digital simulation", () => {
  it("evaluates the AND truth table", () => {
    const cases: Array<[DigitalValue, DigitalValue, DigitalValue]> = [
      ["0", "0", "0"],
      ["0", "1", "0"],
      ["1", "0", "0"],
      ["1", "1", "1"],
    ];

    for (const [a, b, expected] of cases) {
      const circuit = gateCircuit("and", a, b);
      const result = simulateDigitalCircuit(circuit);
      expect(result.componentValues["gate-and"]).toBe(expected);
    }
  });

  it("evaluates OR, NAND, NOR, XOR, and XNOR gates", () => {
    const cases: Array<[string, DigitalValue, DigitalValue, DigitalValue]> = [
      ["or", "0", "0", "0"],
      ["or", "0", "1", "1"],
      ["nand", "1", "1", "0"],
      ["nor", "0", "0", "1"],
      ["xor", "1", "0", "1"],
      ["xnor", "1", "1", "1"],
    ];

    for (const [type, a, b, expected] of cases) {
      const result = simulateDigitalCircuit(gateCircuit(type, a, b));
      expect(result.componentValues[`gate-${type}`]).toBe(expected);
    }
  });

  it("marks unconnected gate inputs as floating", () => {
    const gate = createCircuitComponent("and", { x: 0, y: 0 }, "floating-and");
    const result = simulateDigitalCircuit({ components: [gate], nets: [], gridSize: 20 });

    expect(result.componentValues["floating-and"]).toBe("x");
    expect(result.issues.filter((issue) => issue.code === "FLOATING_INPUT")).toHaveLength(2);
  });

  it("evaluates the shipped example when both switches are high", () => {
    const example = createExampleCircuit();
    const circuit = {
      ...example,
      components: example.components.map((component) => component.id === "example-switch-a" || component.id === "example-switch-b" ? { ...component, value: "1" as const } : component),
    };
    const result = simulateDigitalCircuit(circuit);

    expect(result.componentValues["example-and"]).toBe("1");
    expect(result.componentValues["example-led"]).toBe("1");
    expect(result.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });
});

describe("circuit operations", () => {
  it("merges nets when one output fans out to multiple inputs", () => {
    const source = createCircuitComponent("switch", { x: 0, y: 0 }, "fanout-source");
    const firstGate = createCircuitComponent("and", { x: 180, y: 0 }, "fanout-first");
    const secondGate = createCircuitComponent("and", { x: 180, y: 120 }, "fanout-second");
    let circuit: CircuitDocument = { components: [source, firstGate, secondGate], nets: [], gridSize: 20 };

    circuit = connectPins(circuit, { componentId: source.id, pinId: "out" }, { componentId: firstGate.id, pinId: "a" });
    circuit = connectPins(circuit, { componentId: source.id, pinId: "out" }, { componentId: secondGate.id, pinId: "a" });

    expect(circuit.nets).toHaveLength(1);
    expect(circuit.nets[0].nodeIds).toHaveLength(3);
  });
});
