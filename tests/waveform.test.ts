import { describe, expect, it } from "vitest";
import { createExampleCircuit } from "../src/lib/circuitOperations";
import { captureDigitalWaveform, waveformToCsv } from "../src/lib/waveform";

describe("digital waveform capture", () => {
  it("sweeps every input combination of a combinational circuit", () => {
    const waveform = captureDigitalWaveform(createExampleCircuit(), { maxSamples: 4, stepNs: 5 });

    expect(waveform.kind).toBe("combinational-sweep");
    expect(waveform.samples).toHaveLength(4);
    expect(waveform.signals.map((signal) => signal.values)).toContainEqual(["0", "0", "0", "1"]);
    expect(waveform.samples[3].timeNs).toBe(15);
  });

  it("captures a trainer trace when a clock source is present", () => {
    const base = createExampleCircuit();
    const clockDocument = {
      ...base,
      components: base.components.map((component) =>
        component.id === "example-switch-a" ? { ...component, type: "clock", pins: [{ id: "out", name: "CLK", number: 1, direction: "output" as const, offset: { x: 0, y: 0 } }] } : component,
      ),
    };

    const waveform = captureDigitalWaveform(clockDocument, { maxSamples: 4 });

    expect(waveform.kind).toBe("trainer-trace");
    expect(waveform.signals[0].values).toEqual(["0", "1", "0", "1"]);
  });

  it("exports csv with a header row and one row per sample", () => {
    const csv = waveformToCsv(captureDigitalWaveform(createExampleCircuit(), { maxSamples: 2 }));
    const rows = csv.split("\n");

    expect(rows).toHaveLength(3);
    expect(rows[0].startsWith("time_ns,")).toBe(true);
  });
});
