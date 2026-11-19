import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard } from "../src/components/Dashboard";
import { ProjectSidebar } from "../src/components/ProjectSidebar";
import { getProjectProgress } from "../src/lib/projectStore";
import { createMcuStarter } from "../src/lib/mcuStarter";
import { createExampleCircuit } from "../src/lib/circuitOperations";
import { createProject, type LabProject, type WorkspaceMode } from "../src/types/project";

function project(mode: WorkspaceMode, id: string): LabProject {
  return createProject({ name: `${mode} project`, description: "", mode }, id);
}

describe("project progress status", () => {
  it("reports the 8051 lab versus preview-only labs", () => {
    expect(getProjectProgress(project("mcu", "m1")).status).toBe("empty");
    const filled = { ...project("mcu", "m2"), documents: { mcu: createMcuStarter() } };
    expect(getProjectProgress(filled)).toMatchObject({ status: "ready", artifactCount: 1 });
    expect(getProjectProgress(project("experiments", "e1")).status).toBe("empty");
    const attempted = { ...project("experiments", "e2"), documents: { experiments: { activeId: "x86-loop-sum", sources: { "x86-loop-sum": "MOV AX, 15\nHLT" }, completed: [] } } };
    expect(getProjectProgress(attempted)).toMatchObject({ status: "ready", artifactCount: 1 });
    const solved = { ...project("experiments", "e3"), documents: { experiments: { activeId: "x86-loop-sum", sources: {}, completed: ["x86-loop-sum"] } } };
    expect(getProjectProgress(solved)).toMatchObject({ status: "ready", artifactCount: 1 });
  });

  it("reports empty versus ready for an implemented lab", () => {
    const empty = project("circuit", "c1");
    expect(getProjectProgress(empty)).toMatchObject({ status: "empty", artifactCount: 0 });

    const filled: LabProject = { ...empty, documents: { circuit: createExampleCircuit() } };
    const progress = getProjectProgress(filled);
    expect(progress.status).toBe("ready");
    expect(progress.artifactCount).toBe(7);
  });
});

describe("dashboard shell honesty", () => {
  it("presents every lab as implemented with no preview labels", () => {
    const markup = renderToStaticMarkup(
      <Dashboard
        activeMode="circuit"
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onSelectMode={() => undefined}
        projects={[]}
      />,
    );

    expect(markup).not.toContain("Preview — not implemented");
    expect(markup).not.toContain("Phase 1 foundation");
    expect(markup).toContain("All five labs are functional");
  });

  it("shows a real status pill instead of a hardcoded draft", () => {
    const ready: LabProject = {
      ...project("circuit", "c2"),
      documents: { circuit: createExampleCircuit() },
    };

    const markup = renderToStaticMarkup(
      <Dashboard
        activeMode="circuit"
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onSelectMode={() => undefined}
        projects={[ready]}
      />,
    );

    expect(markup).toContain("status-ready");
    expect(markup).not.toContain(">Draft<");
  });
});

describe("project sidebar honesty", () => {
  it("reports the simulator state for the active lab", () => {
    const render = (mode: WorkspaceMode) => renderToStaticMarkup(
      <ProjectSidebar
        activeMode={mode}
        onCreate={() => undefined}
        onDelete={() => undefined}
        onSearchChange={() => undefined}
        onSelect={() => undefined}
        projects={[]}
        search=""
        selectedProjectId={null}
      />,
    );

    expect(render("circuit")).toContain("Simulator implemented");
    expect(render("mcu")).toContain("Simulator implemented");
    expect(render("experiments")).toContain("Simulator implemented");
    expect(render("experiments")).not.toContain("Preview — no simulator yet");
  });
});
