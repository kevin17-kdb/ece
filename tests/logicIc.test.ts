import { describe, expect, it } from "vitest";
import { createCircuitComponent, pinNodeId } from "../src/lib/circuitCatalog";
import { createTrainerCounterExample, setComponentValue } from "../src/lib/circuitOperations";
import { simulateDigitalCircuit } from "../src/lib/digitalSimulation";
import type { CircuitDocument, DigitalValue } from "../src/types/project";

function buildTrainerBase(): CircuitDocument {
  return createTrainerCounterExample();
}

function runTrainer(document: CircuitDocument, clockValue: DigitalValue, initialState?: Parameters<typeof simulateDigitalCircuit>[1]) {
  return simulateDigitalCircuit(setComponentValue(document, "trainer-clock", clockValue), initialState);
}

describe("multi-unit IC simulation", () => {
  it("evaluates each gate unit of a 74LS00", () => {
    const ic = createCircuitComponent("74ls00", { x: 0, y: 0 }, "u-7400");
    const switchA = createCircuitComponent("switch", { x: 0, y: 0 }, "sw-a");
    const switchB = createCircuitComponent("switch", { x: 0, y: 0 }, "sw-b");
    const vcc = createCircuitComponent("vcc", { x: 0, y: 0 }, "vcc-1");
    const gnd = createCircuitComponent("gnd", { x: 0, y: 0 }, "gnd-1");

    const document: CircuitDocument = {
      components: [ic, switchA, switchB, vcc, gnd],
      nets: [
        { id: "n1", name: "A", nodeIds: [pinNodeId(switchA.id, "out"), pinNodeId(ic.id, "1a"), pinNodeId(ic.id, "2a")] },
        { id: "n2", name: "B", nodeIds: [pinNodeId(switchB.id, "out"), pinNodeId(ic.id, "1b"), pinNodeId(ic.id, "2b")] },
        { id: "n3", name: "VCC", nodeIds: [pinNodeId(vcc.id, "vcc"), pinNodeId(ic.id, "vcc")] },
        { id: "n4", name: "GND", nodeIds: [pinNodeId(gnd.id, "gnd"), pinNodeId(ic.id, "gnd")] },
      ],
    };

    const high = simulateDigitalCircuit({
      ...document,
      components: document.components.map((component) => (component.type === "switch" ? { ...component, value: "1" as const } : component)),
    });

    expect(high.unitValues["u-7400:u1"]).toBe("0");
    expect(high.unitValues["u-7400:u2"]).toBe("0");
    expect(high.issues.some((issue) => issue.code === "POWER_NOT_CONNECTED")).toBe(false);
  });

  it("reports unpowered ICs and drives their outputs to high impedance", () => {
    const ic = createCircuitComponent("74ls08", { x: 0, y: 0 }, "u-7408");
    const result = simulateDigitalCircuit({ components: [ic], nets: [] });

    expect(result.issues.filter((issue) => issue.code === "POWER_NOT_CONNECTED")).toHaveLength(2);
    expect(result.unitValues["u-7408:u1"]).toBe("z");
  });

  it("decodes BCD digits with the 7447 active-low outputs", () => {
    const decoder = createCircuitComponent("7447", { x: 0, y: 0 }, "u-7447");
    const vcc = createCircuitComponent("vcc", { x: 0, y: 0 }, "vcc-2");
    const gnd = createCircuitComponent("gnd", { x: 0, y: 0 }, "gnd-2");
    const inputs = ["a", "b", "c", "d"].map((pin) => createCircuitComponent("switch", { x: 0, y: 0 }, `sw-${pin}`));
    const bits: Record<string, DigitalValue> = { a: "1", b: "0", c: "0", d: "1" };

    const document: CircuitDocument = {
      components: [decoder, vcc, gnd, ...inputs],
      nets: [
        ...inputs.map((component, index) => ({
          id: `n-bit-${index}`,
          name: ["A", "B", "C", "D"][index] ?? "X",
          nodeIds: [pinNodeId(component.id, "out"), pinNodeId(decoder.id, ["a", "b", "c", "d"][index] ?? "a")],
        })),
        { id: "n-lt", name: "LT", nodeIds: [pinNodeId(vcc.id, "vcc"), pinNodeId(decoder.id, "lt"), pinNodeId(decoder.id, "vcc")] },
        { id: "n-rbi", name: "RBI", nodeIds: [pinNodeId(decoder.id, "rbi")] },
        { id: "n-gnd", name: "GND", nodeIds: [pinNodeId(gnd.id, "gnd"), pinNodeId(decoder.id, "gnd")] },
      ],
    };

    const nine = simulateDigitalCircuit({
      ...document,
      components: document.components.map((component) => (component.type === "switch" ? { ...component, value: bits[component.id.replace("sw-", "")] ?? "0" } : component)),
    });

    expect(nine.nodeValues[pinNodeId(decoder.id, "a_out")]).toBe("0");
    expect(nine.nodeValues[pinNodeId(decoder.id, "b_out")]).toBe("0");
    expect(nine.nodeValues[pinNodeId(decoder.id, "c_out")]).toBe("0");
    expect(nine.nodeValues[pinNodeId(decoder.id, "d_out")]).toBe("0");
    expect(nine.nodeValues[pinNodeId(decoder.id, "e")]).toBe("1");
    expect(nine.nodeValues[pinNodeId(decoder.id, "f")]).toBe("0");
    expect(nine.nodeValues[pinNodeId(decoder.id, "g")]).toBe("0");  });
});

describe("sequential trainer circuit", () => {
  it("counts on the falling clock edge and drives the 7-segment display", () => {
    const base = buildTrainerBase();
    const start = runTrainer(base, "0");

    expect(start.displays["trainer-display"]?.glyph).toBe("0");
    expect(start.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);

    const high = runTrainer(base, "1", { initialState: start.state });
    expect(high.displays["trainer-display"]?.glyph).toBe("0");

    const firstFall = runTrainer(base, "0", { initialState: high.state });
    expect(firstFall.displays["trainer-display"]?.glyph).toBe("1");
    expect(firstFall.nodeValues[pinNodeId("trainer-counter", "1q0")]).toBe("1");

    const secondFall = runTrainer(base, "1", { initialState: firstFall.state });
    const thirdFall = runTrainer(base, "0", { initialState: secondFall.state });
    expect(thirdFall.displays["trainer-display"]?.glyph).toBe("2");
  });

  it("does not re-trigger an edge when the clock level is unchanged", () => {
    const base = buildTrainerBase();
    const high = runTrainer(base, "1");
    const falling = runTrainer(base, "0", { initialState: high.state });
    const repeated = runTrainer(base, "0", { initialState: falling.state });

    expect(repeated.nodeValues[pinNodeId("trainer-counter", "1q0")]).toBe("1");
  });
});
