import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MCUWorkspace } from "../src/components/MCUWorkspace";
import { WaveformViewer } from "../src/components/WaveformViewer";
import { createMcuStarter, mcuStarterPrograms } from "../src/lib/mcuStarter";
import { runX8051 } from "../src/lib/mcu8051/simulator";
import { captureX8051Waveform } from "../src/lib/waveform";
import { createProject, type LabProject } from "../src/types/project";

function mcuProject(): LabProject {
  const project = createProject({ name: "8051 Blink LED", description: "Starter", mode: "mcu" }, "test-mcu");
  return { ...project, documents: { mcu: createMcuStarter() } };
}

function sourceFor(id: string): string {
  return mcuStarterPrograms.find((program) => program.id === id)?.source ?? "";
}

describe("8051 workspace", () => {
  it("renders the editor, listing, registers, ports and internal RAM", () => {
    const markup = renderToStaticMarkup(
      <MCUWorkspace onBack={() => undefined} onDelete={() => undefined} onUpdateMcu={() => undefined} project={mcuProject()} />,
    );
    expect(markup).toContain("8051 microcontroller workspace");
    expect(markup).toContain("Listing");
    expect(markup).toContain("Registers");
    expect(markup).toContain("Flags");
    expect(markup).toContain("Ports");
    expect(markup).toContain("Internal RAM");
    expect(markup).toContain("Supported 8051 subset");
  });

  it("walks a lit bit across Port 1 and halts", () => {
    const result = runX8051(sourceFor("blink"));
    expect(result.haltReason).toBe("halted");
    const seen = new Set(result.trace.map((step) => step.ports[1]));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("writes a serial greeting to the console", () => {
    const result = runX8051(sourceFor("serial"));
    expect(result.console.join("")).toBe("Hello\n");
  });

  it("captures an 8051 trace as port signals", () => {
    const result = runX8051(sourceFor("add"));
    const waveform = captureX8051Waveform(result.trace);
    expect(waveform.kind).toBe("mcu-trace");
    expect(waveform.signals.some((signal) => signal.id === "p1" && signal.kind === "bus")).toBe(true);
    expect(waveform.signals.some((signal) => signal.id === "p1.0" && signal.kind === "bit")).toBe(true);

    const markup = renderToStaticMarkup(<WaveformViewer waveform={waveform} />);
    expect(markup).toContain("wave-bus-path");
  });
});
