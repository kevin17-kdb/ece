import { describe, expect, it } from "vitest";
import { createCircuitComponent, pinNodeId } from "../src/lib/circuitCatalog";
import {
  cloneComponent,
  connectPins,
  createExampleCircuit,
  createTrainerCounterExample,
  removeComponent,
  rotateComponent,
  setComponentParameter,
  setComponentValue,
} from "../src/lib/circuitOperations";
import type { CircuitDocument } from "../src/types/project";

function blank(): CircuitDocument {
  const a = createCircuitComponent("switch", { x: 0, y: 0 }, "sw-a");
  const led = createCircuitComponent("led", { x: 200, y: 0 }, "led-1");
  return { gridSize: 20, components: [a, led], nets: [] };
}

describe("connectPins", () => {
  it("creates a net between an output pin and an input pin", () => {
    const document = connectPins(blank(), { componentId: "sw-a", pinId: "out" }, { componentId: "led-1", pinId: "in" });
    expect(document.nets).toHaveLength(1);
    expect(document.nets[0].nodeIds).toEqual([pinNodeId("sw-a", "out"), pinNodeId("led-1", "in")]);
  });

  it("refuses invalid connections (output to output)", () => {
    const document = connectPins(blank(), { componentId: "sw-a", pinId: "out" }, { componentId: "sw-a", pinId: "out" });
    expect(document.nets).toHaveLength(0);
  });

  it("merges two existing nets into one", () => {
    const gate = createCircuitComponent("and", { x: 400, y: 0 }, "and-1");
    const withGate: CircuitDocument = {
      gridSize: 20,
      components: [...blank().components, gate],
      nets: [
        { id: "n1", name: "N1", nodeIds: [pinNodeId("sw-a", "out"), pinNodeId("and-1", "a")] },
        { id: "n2", name: "N2", nodeIds: [pinNodeId("led-1", "in")] },
      ],
    };

    const merged = connectPins(withGate, { componentId: "sw-a", pinId: "out" }, { componentId: "led-1", pinId: "in" });
    expect(merged.nets).toHaveLength(1);
    expect(new Set(merged.nets[0].nodeIds)).toEqual(new Set([pinNodeId("sw-a", "out"), pinNodeId("and-1", "a"), pinNodeId("led-1", "in")]));
  });
});

describe("removeComponent", () => {
  it("removes the component and prunes its nodes from every net", () => {
    const document = createExampleCircuit();
    const trimmed = removeComponent(document, "example-and");

    expect(trimmed.components.some((component) => component.id === "example-and")).toBe(false);
    for (const net of trimmed.nets) {
      expect(net.nodeIds.some((nodeId) => nodeId.startsWith("example-and:"))).toBe(false);
    }
  });
});

describe("component edits", () => {
  it("sets a value on only the target component", () => {
    const document = createExampleCircuit();
    const next = setComponentValue(document, "example-led", "1");
    expect(next.components.find((component) => component.id === "example-led")?.value).toBe("1");
    expect(next.components.find((component) => component.id === "example-and")?.value).toBe(document.components.find((component) => component.id === "example-and")?.value);
  });

  it("merges parameters without dropping existing ones", () => {
    const document = createTrainerCounterExample();
    document.components.push({ ...createCircuitComponent("display7", { x: 0, y: 0 }, "d-1"), parameters: { anode: "anode" } });

    const next = setComponentParameter(document, "d-1", "brightness", 3);
    const display = next.components.find((component) => component.id === "d-1");
    expect(display?.parameters).toMatchObject({ anode: "anode", brightness: 3 });
  });

  it("rotates the target by 90 degrees", () => {
    const document = createExampleCircuit();
    expect(rotateComponent(rotateComponent(document, "example-led"), "example-led").components.find((component) => component.id === "example-led")?.rotation).toBe(180);
    expect(rotateComponent(rotateComponent(rotateComponent(rotateComponent(document, "example-led"), "example-led"), "example-led"), "example-led").components.find((component) => component.id === "example-led")?.rotation).toBe(0);
    expect(rotateComponent(document, "example-led").components.find((component) => component.id === "example-led")?.rotation).toBe(90);
  });
});

describe("cloneComponent", () => {
  it("deep-copies pins and renames the copy", () => {
    const source = createCircuitComponent("and", { x: 10, y: 10 }, "and-src");
    const clone = cloneComponent(source, { x: 40, y: 40 });

    expect(clone.id).not.toBe(source.id);
    expect(clone.label).toBe(`${source.label} copy`);
    expect(clone.position).toEqual({ x: 40, y: 40 });
    expect(clone.pins).not.toBe(source.pins);
    expect(clone.pins[0].offset).not.toBe(source.pins[0].offset);
  });
});
