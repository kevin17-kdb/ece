export const workspaceModes = [
  "circuit",
  "hdl",
  "x86",
  "mcu",
  "esp32",
  "experiments",
] as const;

export type WorkspaceMode = (typeof workspaceModes)[number];

export const modeLabels: Record<WorkspaceMode, string> = {
  circuit: "Circuit Lab",
  hdl: "Digital / HDL",
  x86: "8086 Lab",
  mcu: "MCU Lab",
  esp32: "ESP32 Lab",
  experiments: "Experiments",
};

export type PinDirection = "input" | "output" | "bidirectional" | "power";
export type DigitalValue = "0" | "1" | "x" | "z";

export interface CircuitPin {
  id: string;
  name: string;
  number: number;
  direction: PinDirection;
  offset?: { x: number, y: number };
  unitId?: string;
}

export interface CircuitComponent {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  rotation: number;
  pins: CircuitPin[];
  category?: string;
  value?: DigitalValue;
  parameters?: Record<string, string | number | boolean>;
}

export interface CircuitNet {
  id: string;
  name: string;
  nodeIds: string[];
  color?: string;
}

export interface CircuitDocument {
  components: CircuitComponent[];
  nets: CircuitNet[];
  gridSize?: number;
}

export interface HdlFile {
  path: string;
  language: "verilog" | "systemverilog" | "testbench";
  content: string;
}

export interface HdlDocument {
  topModule: string;
  files: HdlFile[];
  testbench?: string;
}

export interface X86Document {
  source: string;
  machineCode: string[];
}

export interface McuFile {
  path: string;
  language: "c" | "cpp" | "micropython" | "assembly";
  content: string;
}

export interface McuDocument {
  targetId: string;
  files: McuFile[];
  firmware?: {
    format: "hex" | "bin" | "elf";
    artifactId: string;
  };
}

export interface ExperimentDocument {
  activeId: string;
  sources: Record<string, string>;
  completed: string[];
}

export interface ProjectDocuments {
  circuit?: CircuitDocument;
  hdl?: HdlDocument;
  x86?: X86Document;
  mcu?: McuDocument;
  esp32?: McuDocument;
  experiments?: ExperimentDocument;
}

export interface LabProject {
  id: string;
  name: string;
  description: string;
  mode: WorkspaceMode;
  createdAt: string;
  updatedAt: string;
  documents: ProjectDocuments;
}

export interface NewProjectInput {
  name: string;
  description: string;
  mode: WorkspaceMode;
}

function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createDocuments(mode: WorkspaceMode): ProjectDocuments {
  if (mode === "circuit") {
    return { circuit: { components: [], nets: [], gridSize: 20 } };
  }

  if (mode === "hdl") {
    return { hdl: { topModule: "", files: [] } };
  }

  if (mode === "x86") {
    return { x86: { source: "", machineCode: [] } };
  }

  if (mode === "mcu") {
    return { mcu: { targetId: "at89c51", files: [] } };
  }

  if (mode === "esp32") {
    return { esp32: { targetId: "esp32c3", files: [] } };
  }

  if (mode === "experiments") {
    return { experiments: { activeId: "", sources: {}, completed: [] } };
  }

  return {};
}

export function createProject(input: NewProjectInput, id = createId()): LabProject {
  const timestamp = new Date().toISOString();

  return {
    id,
    name: input.name.trim(),
    description: input.description.trim(),
    mode: input.mode,
    createdAt: timestamp,
    updatedAt: timestamp,
    documents: createDocuments(input.mode),
  };
}
