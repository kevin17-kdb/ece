import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentsWorkspace } from "../src/components/ExperimentsWorkspace";
import { createProject, type LabProject } from "../src/types/project";

function experimentsProject(): LabProject {
  return createProject({ name: "Guided Lab: CPU Basics", description: "Starter", mode: "experiments" }, "test-experiments");
}

describe("experiments workspace", () => {
  it("renders the library, brief, editor, and checks", () => {
    const markup = renderToStaticMarkup(
      <ExperimentsWorkspace onBack={() => undefined} onDelete={() => undefined} onUpdateExperiments={() => undefined} project={experimentsProject()} />,
    );

    expect(markup).toContain("Guided experiments workspace");
    expect(markup).toContain("Experiment library");
    expect(markup).toContain("8086 assembly");
    expect(markup).toContain("8051 assembly");
    expect(markup).toContain("Objectives");
    expect(markup).toContain("Steps");
    expect(markup).toContain("Run &amp; check");
    expect(markup).toContain("Automatic checks");
  });

  it("opens the first experiment by default and shows progress", () => {
    const markup = renderToStaticMarkup(
      <ExperimentsWorkspace onBack={() => undefined} onDelete={() => undefined} onUpdateExperiments={() => undefined} project={experimentsProject()} />,
    );

    expect(markup).toContain("Sum 1 to 5 with a loop");
    expect(markup).toContain("solution.asm");
    expect(markup).toContain("/5 solved");
    expect(markup).toContain("In progress");
  });

  it("marks a solved experiment and shows the saved source", () => {
    const base = experimentsProject();
    const project: LabProject = {
      ...base,
      documents: {
        experiments: {
          activeId: "mcu-count",
          sources: { "mcu-count": "MOV R0, #0\nLOOP: INC R0\nCJNE R0, #10, LOOP\nHERE: SJMP HERE\n" },
          completed: ["mcu-count"],
        },
      },
    };

    const markup = renderToStaticMarkup(
      <ExperimentsWorkspace onBack={() => undefined} onDelete={() => undefined} onUpdateExperiments={() => undefined} project={project} />,
    );

    expect(markup).toContain("Count to ten in R0");
    expect(markup).toContain("1/5 solved");
    expect(markup).toContain("solution.a51");
  });
});
