import { afterEach, describe, expect, it } from "vitest";
import {
  countProjectArtifacts,
  getProjectProgress,
  loadProjects,
  migrateProject,
  persistProjects,
  seedExperimentsProject,
} from "../src/lib/projectStore";
import { createProject, type LabProject } from "../src/types/project";

const legacyStorageKey = "universal-electronics-lab.projects.v1";
const v2StorageKey = "universal-electronics-lab.projects.v2";

interface FakeStorageWindow {
  localStorage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };
}

function installFakeWindow(): Map<string, string> {
  const store = new Map<string, string>();
  const fakeWindow: FakeStorageWindow = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) ?? null : null),
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    },
  };

  (globalThis as unknown as { window: FakeStorageWindow }).window = fakeWindow;
  return store;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("countProjectArtifacts", () => {
  it("counts circuit components and nets", () => {
    const project = createProject({ name: "Trainer", description: "", mode: "circuit" }, "c1");
    project.documents.circuit = {
      components: [
        { id: "u1", type: "and", label: "U1", position: { x: 0, y: 0 }, rotation: 0, pins: [] },
        { id: "u2", type: "or", label: "U2", position: { x: 0, y: 0 }, rotation: 0, pins: [] },
      ],
      nets: [{ id: "n1", name: "N1", nodeIds: ["u1.1", "u2.1"] }],
    };

    expect(countProjectArtifacts(project)).toBe(3);
  });

  it("counts saved experiment sources and completed labs", () => {
    const project = createProject({ name: "Lab", description: "", mode: "experiments" }, "e1");
    project.documents.experiments = {
      activeId: "x86-store-memory",
      sources: { "x86-store-memory": "MOV AX, 1\n", "mcu-count": "   " },
      completed: ["x86-store-memory"],
    };

    expect(countProjectArtifacts(project)).toBe(2);
  });
});

describe("migrateProject", () => {
  it("fills in a missing experiments document for the experiments mode", () => {
    const project = createProject({ name: "Lab", description: "", mode: "experiments" }, "e2");
    project.documents = {};

    const migrated = migrateProject(project);
    expect(migrated.documents.experiments).toEqual({ activeId: "", sources: {}, completed: [] });
  });

  it("preserves existing experiment progress", () => {
    const project = createProject({ name: "Lab", description: "", mode: "experiments" }, "e3");
    project.documents.experiments = {
      activeId: "mcu-count",
      sources: { "mcu-count": "MOV R0, #0\n" },
      completed: ["mcu-count"],
    };

    const migrated = migrateProject(project);
    expect(migrated.documents.experiments).toEqual({
      activeId: "mcu-count",
      sources: { "mcu-count": "MOV R0, #0\n" },
      completed: ["mcu-count"],
    });
  });

  it("leaves non-experiment projects untouched", () => {
    const project = createProject({ name: "CPU", description: "", mode: "x86" }, "x1");
    const migrated = seedExperimentsProject(project);
    expect(migrated).toBe(project);
  });
});

describe("persistence", () => {
  it("round-trips projects through the versioned envelope", () => {
    const store = installFakeWindow();
    const project = createProject({ name: "CPU", description: "", mode: "x86" }, "x2");
    project.documents.x86 = { source: "HLT\n", machineCode: ["F4"] };

    persistProjects([project]);

    const raw = store.get(v2StorageKey);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw ?? "null")).toMatchObject({ version: 2 });

    const loaded = loadProjects();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("x2");
  });

  it("migrates a legacy v1 array into the current schema", () => {
    const store = installFakeWindow();
    const legacy = createProject({ name: "Old Lab", description: "", mode: "experiments" }, "legacy-1");
    legacy.documents = {};
    store.set(legacyStorageKey, JSON.stringify([legacy]));

    const loaded = loadProjects();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].documents.experiments).toEqual({ activeId: "", sources: {}, completed: [] });
  });
});

describe("getProjectProgress", () => {
  it("reports ready when artifacts exist and empty otherwise", () => {
    const project: LabProject = createProject({ name: "CPU", description: "", mode: "x86" }, "x3");
    expect(getProjectProgress(project).status).toBe("empty");

    project.documents.x86 = { source: "MOV AX, 1\n", machineCode: [] };
    expect(getProjectProgress(project)).toMatchObject({ status: "ready", artifactCount: 1 });
  });
});
