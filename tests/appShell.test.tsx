import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "../src/App";
import { CreateProjectModal } from "../src/components/CreateProjectModal";
import { WorkspaceView } from "../src/components/WorkspaceView";
import { createProject, modeLabels, workspaceModes, type LabProject, type WorkspaceMode } from "../src/types/project";

function project(mode: WorkspaceMode, id: string): LabProject {
  return createProject({ name: `${mode} project`, description: "", mode }, id);
}

const noop = () => undefined;

function renderWorkspace(mode: WorkspaceMode): string {
  return renderToStaticMarkup(
    <WorkspaceView
      onBack={noop}
      onDelete={noop}
      onUpdate={noop}
      onUpdateCircuit={noop}
      onUpdateHdl={noop}
      onUpdateX86={noop}
      onUpdateMcu={noop}
      onUpdateExperiments={noop}
      project={project(mode, `ws-${mode}`)}
    />,
  );
}

describe("app shell", () => {
  it("renders the brand, nav tabs, and new-project action", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("Universal Electronics Lab");
    expect(markup).toContain("Workspaces");
    expect(markup).toContain("New project");
    for (const mode of workspaceModes) {
      expect(markup).toContain(modeLabels[mode]);
    }
  });
});

describe("create project modal", () => {
  it("renders a dialog with every workspace mode and a create button", () => {
    const markup = renderToStaticMarkup(
      <CreateProjectModal initialMode="circuit" onClose={noop} onCreate={noop} />,
    );

    expect(markup).toContain("Create a project");
    expect(markup).toContain("Create project");
    for (const mode of workspaceModes) {
      expect(markup).toContain(modeLabels[mode]);
    }
  });
});

describe("workspace routing", () => {
  it("selects the routed workspace for each mode (lazy fallback carries the mode label)", () => {
    for (const mode of workspaceModes) {
      const markup = renderWorkspace(mode);
      expect(markup).toContain("workspace-loading");
      expect(markup).toContain(`Loading ${modeLabels[mode]} workspace`);
    }
  });

  it("lazy loaders resolve to the exported workspace components", async () => {
    const [circuit, hdl, x86, mcu, experiments] = await Promise.all([
      import("../src/components/CircuitWorkspace"),
      import("../src/components/HDLWorkspace"),
      import("../src/components/X86Workspace"),
      import("../src/components/MCUWorkspace"),
      import("../src/components/ExperimentsWorkspace"),
    ]);

    expect(typeof circuit.CircuitWorkspace).toBe("function");
    expect(typeof hdl.HDLWorkspace).toBe("function");
    expect(typeof x86.X86Workspace).toBe("function");
    expect(typeof mcu.MCUWorkspace).toBe("function");
    expect(typeof experiments.ExperimentsWorkspace).toBe("function");
  });
});
