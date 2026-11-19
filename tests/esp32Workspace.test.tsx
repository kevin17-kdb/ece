import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ESP32Workspace } from "../src/components/ESP32Workspace";
import { WaveformViewer } from "../src/components/WaveformViewer";
import { assemble } from "../src/lib/esp32/assembler";
import { createMachine, runMachine } from "../src/lib/esp32/simulator";
import { createEsp32Starter, esp32StarterPrograms } from "../src/lib/esp32Starter";
import { captureEsp32Waveform } from "../src/lib/waveform";
import { createProject, type LabProject } from "../src/types/project";

function esp32Project(): LabProject {
  const project = createProject({ name: "ESP32 Blink", description: "Starter", mode: "esp32" }, "test-esp32");
  return { ...project, documents: { esp32: createEsp32Starter() } };
}

function sourceFor(id: string): string {
  return esp32StarterPrograms.find((program) => program.id === id)?.source ?? "";
}

describe("ESP32 workspace", () => {
  it("renders the editor, listing, registers, GPIO and UART panels", () => {
    const markup = renderToStaticMarkup(
      <ESP32Workspace onBack={() => undefined} onDelete={() => undefined} onUpdateEsp32={() => undefined} project={esp32Project()} />,
    );
    expect(markup).toContain("ESP32-C3 microcontroller workspace");
    expect(markup).toContain("Listing");
    expect(markup).toContain("Registers");
    expect(markup).toContain("GPIO");
    expect(markup).toContain("Data memory");
    expect(markup).toContain("UART TX");
    expect(markup).toContain("Supported ESP32-C3 subset");
  });

  it("sums a running total in the starter count program", () => {
    const result = runMachine(createMachine(assemble(sourceFor("count"))));
    expect(result.haltReason).toBe("halted");
    expect(result.finalState.registers[10]).toBe(55);
  });

  it("captures an ESP32 trace as GPIO signals", () => {
    const result = runMachine(createMachine(assemble(sourceFor("blink"))));
    const waveform = captureEsp32Waveform(result.trace);
    expect(waveform.kind).toBe("esp32-trace");
    expect(waveform.signals.some((signal) => signal.id === "gpio" && signal.kind === "bus")).toBe(true);
    expect(waveform.signals.some((signal) => signal.id === "gpio.0" && signal.kind === "bit")).toBe(true);

    const markup = renderToStaticMarkup(<WaveformViewer waveform={waveform} />);
    expect(markup).toContain("wave-bus-path");
  });
});
