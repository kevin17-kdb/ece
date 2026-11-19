import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HDLWorkspace } from "../src/components/HDLWorkspace";
import { WaveformViewer } from "../src/components/WaveformViewer";
import { createFullAdderStarter } from "../src/lib/hdlStarter";
import { captureVerilogWaveform } from "../src/lib/waveform";
import { simulateVerilog } from "../src/lib/verilog/simulator";
import { createProject, type LabProject } from "../src/types/project";

function hdlProject(): LabProject {
  const project = createProject({ name: "Full Adder", description: "Starter", mode: "hdl" }, "test-hdl");
  return { ...project, documents: { hdl: createFullAdderStarter() } };
}

describe("HDL workspace render", () => {
  it("renders the file tree, editor, and console for a starter project", () => {
    const markup = renderToStaticMarkup(
      <HDLWorkspace
        onBack={() => undefined}
        onDelete={() => undefined}
        onUpdateHdl={() => undefined}
        project={hdlProject()}
      />,
    );

    expect(markup).toContain("Full Adder");
    expect(markup).toContain("Run simulation");
    expect(markup).toContain("tb_full_adder.v");
    expect(markup).toContain("module half_adder");
    expect(markup).toContain("Supported Verilog subset");
    expect(markup).toContain("Run the simulation to collect $display output.");
  });

  it("renders a bus trace as a bus row instead of a bit row", () => {
    const document = createFullAdderStarter();
    const result = simulateVerilog(document.files.map((file) => ({ path: file.path, content: file.content })), { topModule: document.topModule });
    const markup = renderToStaticMarkup(<WaveformViewer waveform={captureVerilogWaveform(result)} />);

    expect(markup).toContain("wave-bus-path");
    expect(markup).toContain("[31:0]");
    expect(markup).toContain("32&#x27;h00000000");
  });
});
