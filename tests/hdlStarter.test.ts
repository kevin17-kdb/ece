import { describe, expect, it } from "vitest";
import { createCounterStarter, createFullAdderStarter, createHdlTemplate } from "../src/lib/hdlStarter";
import { captureVerilogWaveform } from "../src/lib/waveform";
import { simulateVerilog, type VerilogSimulationResult } from "../src/lib/verilog/simulator";
import type { HdlDocument } from "../src/types/project";

function run(document: HdlDocument): VerilogSimulationResult {
  return simulateVerilog(
    document.files.map((file) => ({ path: file.path, content: file.content })),
    { topModule: document.topModule },
  );
}

function transcript(result: VerilogSimulationResult): string {
  return result.log.map((entry) => entry.text).join("\n");
}

describe("HDL starter projects", () => {
  it("runs the full adder starter and reports every input combination", () => {
    const result = run(createFullAdderStarter());

    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(transcript(result)).toContain("PASS full_adder: 8 of 8 combinations matched");
    expect(transcript(result).match(/ {2}ok /g)).toHaveLength(8);
  });

  it("runs the counter starter and reports the clocked sequence", () => {
    const result = run(createCounterStarter());

    expect(result.ok).toBe(true);
    expect(transcript(result)).toContain("PASS counter reached 4");
    expect(transcript(result)).toContain("at 50ns");
  });

  it("runs the new-project template", () => {
    const result = run(createHdlTemplate());

    expect(result.ok).toBe(true);
    expect(transcript(result)).toContain("PASS combinational: 4 of 4 combinations matched");
  });

  it("captures a bus trace for the counter", () => {
    const waveform = captureVerilogWaveform(run(createCounterStarter()), { signalPaths: ["count"] });
    const count = waveform.signals[0];

    expect(count.kind).toBe("bus");
    expect(count.width).toBe(4);
    expect(count.values[0]).toBe("4'hx");
    expect(count.values[count.values.length - 1]).toBe("4'h4");
  });

  it("keeps hierarchical signals in the trace and collapses aliased ports", () => {
    const adder = run(createFullAdderStarter());
    const adderPaths = adder.signals.map((signal) => signal.path);

    expect(adderPaths).toContain("dut.lower_sum");
    expect(adderPaths).toContain("dut.upper_carry");
    expect(adderPaths).not.toContain("dut.a");
    expect(new Set(adderPaths).size).toBe(adderPaths.length);

    const counterPaths = run(createCounterStarter()).signals.map((signal) => signal.path);
    expect(counterPaths).not.toContain("dut.clk");
  });
});
