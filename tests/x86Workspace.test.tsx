import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { X86Workspace } from "../src/components/X86Workspace";
import { WaveformViewer } from "../src/components/WaveformViewer";
import { createX86RegisterStarter, createX86TrainerStarter } from "../src/lib/x86Starter";
import { simulateX86 } from "../src/lib/x86/simulator";
import { captureX86Waveform } from "../src/lib/waveform";
import { createProject, type LabProject } from "../src/types/project";

function x86Project(): LabProject {
  const project = createProject({ name: "8086 Register Demo", description: "Starter", mode: "x86" }, "test-x86");
  return { ...project, documents: { x86: createX86RegisterStarter() } };
}

describe("x86 workspace", () => {
  it("renders the source, listing, registers, and trainer ports", () => {
    const markup = renderToStaticMarkup(
      <X86Workspace onBack={() => undefined} onDelete={() => undefined} onUpdateX86={() => undefined} project={x86Project()} />,
    );

    expect(markup).toContain("8086 assembly workspace");
    expect(markup).toContain("program.asm");
    expect(markup).toContain("Listing");
    expect(markup).toContain("Registers");
    expect(markup).toContain("Flags");
    expect(markup).toContain("Trainer ports");
    expect(markup).toContain("AX");
    expect(markup).toContain("8086 demo: registers, flags, and memory");
  });

  it("exposes breakpoints, watches, and memory editing", () => {
    const markup = renderToStaticMarkup(
      <X86Workspace onBack={() => undefined} onDelete={() => undefined} onUpdateX86={() => undefined} project={x86Project()} />,
    );

    expect(markup).toContain("breakpoint");
    expect(markup).toContain("Watches");
    expect(markup).toContain("Edit byte");
    expect(markup).toContain("Memory edit address");
  });

  it("captures a register trace as bus signals", () => {
    const result = simulateX86({ source: createX86RegisterStarter().source });
    expect(result.haltReason).toBe("terminated");
    const waveform = captureX86Waveform(result.trace);
    expect(waveform.kind).toBe("x86-trace");
    expect(waveform.signals.some((signal) => signal.id === "ax" && signal.kind === "bus")).toBe(true);

    const markup = renderToStaticMarkup(<WaveformViewer waveform={waveform} />);
    expect(markup).toContain("wave-bus-path");
  });

  it("runs the trainer demo and prints to the console", () => {
    const result = simulateX86({ source: createX86TrainerStarter().source });
    expect(result.haltReason).toBe("terminated");
    expect(result.console.join("")).toContain("8086 trainer: switches -> adder -> LEDs");
  });
});
