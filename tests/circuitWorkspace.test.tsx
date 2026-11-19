import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CircuitWorkspace } from "../src/components/CircuitWorkspace";
import { createExampleCircuit } from "../src/lib/circuitOperations";
import { createProject, type LabProject } from "../src/types/project";

function circuitProject(withExample: boolean): LabProject {
  const project = createProject({ name: "Circuit", description: "", mode: "circuit" }, "test-circuit");
  if (withExample) {
    return { ...project, documents: { circuit: createExampleCircuit() } };
  }

  return project;
}

function render(project: LabProject) {
  return renderToStaticMarkup(
    <CircuitWorkspace onBack={() => undefined} onDelete={() => undefined} onUpdateCircuit={() => undefined} project={project} />,
  );
}

describe("circuit workspace UX", () => {
  it("exposes undo/redo, search, and zoom controls", () => {
    const markup = render(circuitProject(true));

    expect(markup).toContain("Undo (Ctrl+Z)");
    expect(markup).toContain("Redo (Ctrl+Shift+Z)");
    expect(markup).toContain("Search components");
    expect(markup).toContain("Zoom to fit");
    expect(markup).toContain("All changes saved");
    expect(markup).toContain("Truth table");
  });

  it("renders component values for the example circuit", () => {
    const markup = render(circuitProject(true));

    expect(markup).toContain("AND gate");
    expect(markup).toContain("Component values");
    expect(markup).toContain("4 components");
  });

  it("shows the empty state for a blank schematic", () => {
    const markup = render(circuitProject(false));

    expect(markup).toContain("Start your schematic");
  });
});
