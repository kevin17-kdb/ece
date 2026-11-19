import { describe, expect, it } from "vitest";
import { createExampleCircuit, createTrainerCounterExample } from "../src/lib/circuitOperations";
import { buildNetlist, toSpiceNetlist } from "../src/lib/netlist";

describe("netlist builder", () => {
  it("classifies drivers and sinks for every net", () => {
    const netlist = buildNetlist(createExampleCircuit());

    expect(netlist.nets).toHaveLength(3);
    const netA = netlist.nets.find((net) => net.name === "A");
    expect(netA?.drivers.map((node) => node.pinName)).toEqual(["OUT"]);
    expect(netA?.sinks.map((node) => node.pinName)).toEqual(["A"]);
  });

  it("reports unconnected input pins", () => {
    const netlist = buildNetlist(createTrainerCounterExample());

    expect(netlist.components.some((component) => component.part === "74LS393")).toBe(true);
    expect(netlist.unconnectedPins.every((node) => node.direction === "input")).toBe(true);
  });

  it("writes a spice-style digital netlist", () => {
    const text = toSpiceNetlist(createTrainerCounterExample());

    expect(text).toContain("* Digital netlist");
    expect(text).toMatch(/U\d+ 74LS393/);
    expect(text).toMatch(/U\d+ 7447/);
    expect(text).toContain("* Nets");
  });
});
