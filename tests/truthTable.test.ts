import { describe, expect, it } from "vitest";
import { createCircuitComponent, pinNodeId } from "../src/lib/circuitCatalog";
import { createExampleCircuit, setComponentValue } from "../src/lib/circuitOperations";
import { simulateDigitalCircuit } from "../src/lib/digitalSimulation";
import { buildTruthTable } from "../src/lib/truthTable";

describe("truth table builder", () => {
  it("enumerates every input combination against the real simulator", () => {
    const table = buildTruthTable(createExampleCircuit());

    expect(table).not.toBeNull();
    expect(table?.inputs).toHaveLength(2);
    expect(table?.outputs).toHaveLength(1);
    expect(table?.rows).toHaveLength(4);

    const andRows = table?.rows.map((row) => [row.inputs.join(""), row.outputs[0]]);
    expect(andRows).toEqual([
      ["00", "0"],
      ["01", "0"],
      ["10", "0"],
      ["11", "1"],
    ]);
  });

  it("returns null when there are no enumerable inputs", () => {
    const led = createCircuitComponent("led", { x: 0, y: 0 }, "solo-led");
    const table = buildTruthTable({ components: [led], nets: [] });

    expect(table).toBeNull();
  });

  it("reports truncation when combinations exceed the row cap", () => {
    const switches = Array.from({ length: 4 }, (_, index) => createCircuitComponent("switch", { x: index, y: 0 }, `sw-${index}`));
    const led = createCircuitComponent("led", { x: 0, y: 0 }, "led");
    const table = buildTruthTable({ components: [...switches, led], nets: [] }, { maxRows: 8 });

    expect(table?.rows).toHaveLength(8);
    expect(table?.truncated).toBe(true);
  });
});

describe("buffer and probe components", () => {
  it("passes a buffer input through without inversion", () => {
    const source = createCircuitComponent("switch", { x: 0, y: 0 }, "sw");
    const buffer = createCircuitComponent("buffer", { x: 200, y: 0 }, "buf");
    const probe = createCircuitComponent("probe", { x: 400, y: 0 }, "probe");
    const document = setComponentValue(
      {
        components: [source, buffer, probe],
        nets: [
          { id: "n1", name: "A", nodeIds: [pinNodeId(source.id, "out"), pinNodeId(buffer.id, "in")] },
          { id: "n2", name: "Y", nodeIds: [pinNodeId(buffer.id, "out"), pinNodeId(probe.id, "in")] },
        ],
      },
      "sw",
      "1",
    );

    const result = simulateDigitalCircuit(document);

    expect(result.componentValues["buf"]).toBe("1");
    expect(result.componentValues["probe"]).toBe("1");
  });
});
