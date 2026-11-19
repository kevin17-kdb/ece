import {
  createProject,
  type LabProject,
  type NewProjectInput,
  type WorkspaceMode,
} from "../types/project";
import { createTrainerCounterExample } from "./circuitOperations";
import { createFullAdderStarter, createHdlTemplate } from "./hdlStarter";
import { createMcuStarter, getMcuSource } from "./mcuStarter";
import { createEsp32Starter, getEsp32Source } from "./esp32Starter";
import { createX86RegisterStarter } from "./x86Starter";

const storageKey = "universal-electronics-lab.projects.v2";
const legacyStorageKey = "universal-electronics-lab.projects.v1";
export const projectSchemaVersion = 2;

interface StoredEnvelope {
  version: number;
  projects: unknown[];
}

const starterProjects: Array<{
  id: string;
  input: NewProjectInput;
  timestamp: string;
}> = [
  {
    id: "starter-digital-trainer",
    input: {
      name: "Digital IC Trainer",
      description: "A workspace for 74xx logic, clocked experiments, and trainer-kit circuits.",
      mode: "circuit",
    },
    timestamp: "2026-01-12T09:00:00.000Z",
  },
  {
    id: "starter-full-adder",
    input: {
      name: "Full Adder",
      description: "A Verilog workspace for digital design, testbenches, waveforms, and RTL views.",
      mode: "hdl",
    },
    timestamp: "2026-01-15T13:30:00.000Z",
  },
  {
    id: "starter-8086-registers",
    input: {
      name: "8086 Register Demo",
      description: "An assembly workspace for CPU state, flags, memory, and step debugging.",
      mode: "x86",
    },
    timestamp: "2026-01-18T16:15:00.000Z",
  },
  {
    id: "starter-8051-blink",
    input: {
      name: "8051 Blink LED",
      description: "A microcontroller workspace for firmware, target selection, and GPIO waveforms.",
      mode: "mcu",
    },
    timestamp: "2026-01-21T11:45:00.000Z",
  },
  {
    id: "starter-esp32-blink",
    input: {
      name: "ESP32-C3 GPIO Blink",
      description: "A RISC-V workspace for ESP32-C3 firmware, GPIO output, and UART.",
      mode: "esp32",
    },
    timestamp: "2026-01-23T09:10:00.000Z",
  },
  {
    id: "starter-guided-lab",
    input: {
      name: "Guided Lab: CPU Basics",
      description: "Work through 8086 and 8051 exercises with automatic checks against the real simulators.",
      mode: "experiments",
    },
    timestamp: "2026-01-24T10:20:00.000Z",
  },
];

function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return (
    value === "circuit" ||
    value === "hdl" ||
    value === "x86" ||
    value === "mcu" ||
    value === "esp32" ||
    value === "experiments"
  );
}

function isStoredProject(value: unknown): value is LabProject {
  if (!value || typeof value !== "object") {
    return false;
  }

  const project = value as Partial<LabProject>;
  return (
    typeof project.id === "string" &&
    typeof project.name === "string" &&
    typeof project.description === "string" &&
    typeof project.createdAt === "string" &&
    typeof project.updatedAt === "string" &&
    isWorkspaceMode(project.mode) &&
    typeof project.documents === "object"
  );
}

/**
 * Normalises a persisted project to the current schema, preserving any unknown
 * fields and filling in missing per-mode documents without overwriting content.
 */
export function migrateProject(project: LabProject): LabProject {
  return seedExperimentsProject(seedEsp32Project(seedMcuProject(seedX86Project(seedHdlProject(project)))));
}

export function loadProjects(): LabProject[] {
  if (typeof window === "undefined") {
    return createStarterProjects();
  }

  try {
    const raw = readRawProjects();
    if (!raw) {
      return createStarterProjects();
    }

    return raw.filter(isStoredProject).map(migrateProject);
  } catch {
    return createStarterProjects();
  }
}

function readRawProjects(): unknown[] | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed;
      }

      if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as StoredEnvelope).projects)) {
        return (parsed as StoredEnvelope).projects;
      }
    }

    const legacy = window.localStorage.getItem(legacyStorageKey);
    if (legacy) {
      const parsed: unknown = JSON.parse(legacy);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function persistProjects(projects: LabProject[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const envelope: StoredEnvelope = { version: projectSchemaVersion, projects };
    window.localStorage.setItem(storageKey, JSON.stringify(envelope));
  } catch {
    return;
  }
}

export function makeProject(input: NewProjectInput): LabProject {
  return seedExperimentsProject(seedEsp32Project(seedMcuProject(seedX86Project(seedHdlProject(createProject(input))))));
}

export function seedHdlProject(project: LabProject): LabProject {
  const hdl = project.mode === "hdl" ? project.documents.hdl : undefined;
  if (hdl && hdl.files.length > 0) {
    return project;
  }

  if (project.mode !== "hdl") {
    return project;
  }

  return { ...project, documents: { ...project.documents, hdl: createHdlTemplate() } };
}

export interface ProjectProgress {
  artifactCount: number;
  status: "empty" | "ready" | "planned";
  statusLabel: string;
}

export function countProjectArtifacts(project: LabProject): number {
  if (project.mode === "circuit") {
    const circuit = project.documents.circuit;
    return circuit ? circuit.components.length + circuit.nets.length : 0;
  }

  if (project.mode === "hdl") {
    const hdl = project.documents.hdl;
    return hdl ? hdl.files.length + (hdl.testbench ? 1 : 0) : 0;
  }

  if (project.mode === "x86") {
    return project.documents.x86?.source.trim() ? 1 : 0;
  }

  if (project.mode === "mcu") {
    return getMcuSource(project.documents.mcu).trim() ? 1 : 0;
  }

  if (project.mode === "esp32") {
    return getEsp32Source(project.documents.esp32).trim() ? 1 : 0;
  }

  if (project.mode === "experiments") {
    const experiments = project.documents.experiments;
    const saved = experiments ? Object.values(experiments.sources).filter((source) => source.trim().length > 0).length : 0;
    return saved + (experiments?.completed.length ?? 0);
  }

  return 0;
}

export function getProjectProgress(project: LabProject): ProjectProgress {
  const artifactCount = countProjectArtifacts(project);
  return artifactCount > 0
    ? { artifactCount, status: "ready", statusLabel: "Ready" }
    : { artifactCount: 0, status: "empty", statusLabel: "Empty" };
}

export function seedX86Project(project: LabProject): LabProject {
  const x86 = project.mode === "x86" ? project.documents.x86 : undefined;
  if (x86 && x86.source.trim().length > 0) {
    return project;
  }

  if (project.mode !== "x86") {
    return project;
  }

  return { ...project, documents: { ...project.documents, x86: createX86RegisterStarter() } };
}

export function seedMcuProject(project: LabProject): LabProject {
  const mcu = project.mode === "mcu" ? project.documents.mcu : undefined;
  if (mcu && getMcuSource(mcu).trim().length > 0) {
    return project;
  }

  if (project.mode !== "mcu") {
    return project;
  }

  return { ...project, documents: { ...project.documents, mcu: createMcuStarter() } };
}

export function seedEsp32Project(project: LabProject): LabProject {
  const esp32 = project.mode === "esp32" ? project.documents.esp32 : undefined;
  if (esp32 && getEsp32Source(esp32).trim().length > 0) {
    return project;
  }

  if (project.mode !== "esp32") {
    return project;
  }

  return { ...project, documents: { ...project.documents, esp32: createEsp32Starter() } };
}

export function seedExperimentsProject(project: LabProject): LabProject {
  if (project.mode !== "experiments") {
    return project;
  }

  const experiments = project.documents.experiments;
  if (experiments && typeof experiments.activeId === "string" && experiments.sources && Array.isArray(experiments.completed)) {
    return project;
  }

  return {
    ...project,
    documents: {
      ...project.documents,
      experiments: {
        activeId: experiments?.activeId ?? "",
        sources: experiments?.sources ?? {},
        completed: experiments?.completed ?? [],
      },
    },
  };
}

function createStarterProjects(): LabProject[] {
  return starterProjects.map(({ id, input, timestamp }) => {
    const project = seedMcuProject(seedX86Project(seedHdlProject(createProject(input, id))));
    if (project.id === "starter-digital-trainer" && project.documents.circuit) {
      project.documents.circuit = createTrainerCounterExample();
    }

    if (project.id === "starter-full-adder") {
      project.documents.hdl = createFullAdderStarter();
    }

    return { ...project, createdAt: timestamp, updatedAt: timestamp };
  });
}
