import { lazy, Suspense, useEffect, useState } from "react";
import { countProjectArtifacts } from "../lib/projectStore";
import { modeLabels, type CircuitDocument, type ExperimentDocument, type HdlDocument, type LabProject, type McuDocument, type WorkspaceMode, type X86Document } from "../types/project";
const CircuitWorkspace = lazy(() => import("./CircuitWorkspace").then((module) => ({ default: module.CircuitWorkspace })));
const ExperimentsWorkspace = lazy(() => import("./ExperimentsWorkspace").then((module) => ({ default: module.ExperimentsWorkspace })));
const HDLWorkspace = lazy(() => import("./HDLWorkspace").then((module) => ({ default: module.HDLWorkspace })));
const X86Workspace = lazy(() => import("./X86Workspace").then((module) => ({ default: module.X86Workspace })));
const MCUWorkspace = lazy(() => import("./MCUWorkspace").then((module) => ({ default: module.MCUWorkspace })));
const ESP32Workspace = lazy(() => import("./ESP32Workspace").then((module) => ({ default: module.ESP32Workspace })));
import { Icon, type IconName } from "./Icon";

interface WorkspaceViewProps {
  project: LabProject;
  onBack: () => void;
  onDelete: (projectId: string) => void;
  onUpdate: (projectId: string, changes: Partial<Pick<LabProject, "name" | "description">>) => void;
  onUpdateCircuit: (projectId: string, circuit: CircuitDocument) => void;
  onUpdateHdl: (projectId: string, hdl: HdlDocument) => void;
  onUpdateX86: (projectId: string, x86: X86Document) => void;
  onUpdateMcu: (projectId: string, mcu: McuDocument) => void;
  onUpdateEsp32: (projectId: string, esp32: McuDocument) => void;
  onUpdateExperiments: (projectId: string, experiments: ExperimentDocument) => void;
}

interface WorkspaceSection {
  title: string;
  description: string;
  icon: IconName;
  status: string;
}

const sections: Record<WorkspaceMode, WorkspaceSection[]> = {
  circuit: [
    { title: "Schematic canvas", description: "Place symbols, connect nets, and validate power pins.", icon: "circuit", status: "Planned" },
    { title: "Breadboard", description: "Map holes and jumper wires into the same circuit document.", icon: "grid", status: "Planned" },
    { title: "Digital trainer", description: "Run clocks, switches, LEDs, displays, and logic probes.", icon: "activity", status: "Planned" },
  ],
  hdl: [
    { title: "Source files", description: "Organize RTL and testbench files in a project tree.", icon: "code", status: "Planned" },
    { title: "Testbench runner", description: "Compile, elaborate, and execute a supported Verilog subset.", icon: "play", status: "Planned" },
    { title: "Waveform output", description: "Inspect VCD signals and export timing diagrams.", icon: "activity", status: "Planned" },
  ],
  x86: [
    { title: "Assembly source", description: "Write 8086 programs with a listing and machine-code view.", icon: "file", status: "Planned" },
    { title: "CPU debugger", description: "Run, pause, step, and inspect registers and flags.", icon: "cpu", status: "Planned" },
    { title: "Memory and I/O", description: "Connect ports to virtual switches, LEDs, and displays.", icon: "layers", status: "Planned" },
  ],
  mcu: [
    { title: "Firmware project", description: "Create C, C++, Assembly, or MicroPython source files.", icon: "code", status: "Planned" },
    { title: "Target and build", description: "Select a device, build, link, and load a firmware artifact.", icon: "settings", status: "Planned" },
    { title: "Peripheral waveforms", description: "Trace GPIO, timers, UART, ADC, PWM, and buses.", icon: "activity", status: "Planned" },
  ],
  esp32: [
    { title: "RISC-V firmware", description: "Write ESP32-C3 assembly with a listing and machine-code view.", icon: "code", status: "Planned" },
    { title: "CPU debugger", description: "Run, step, and inspect the RV32 register file and program counter.", icon: "cpu", status: "Planned" },
    { title: "GPIO and UART", description: "Trace GPIO output bits and UART transmit characters.", icon: "activity", status: "Planned" },
  ],
  experiments: [
    { title: "Experiment library", description: "Browse guided electronics and embedded systems labs.", icon: "book", status: "Planned" },
    { title: "Measurements", description: "Collect scope, logic analyzer, and multimeter results.", icon: "activity", status: "Planned" },
    { title: "Validation", description: "Check wiring, behavior, and learning objectives.", icon: "check", status: "Planned" },
  ],
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

export function WorkspaceView({ project, onBack, onDelete, onUpdate, onUpdateCircuit, onUpdateHdl, onUpdateX86, onUpdateMcu, onUpdateEsp32, onUpdateExperiments }: WorkspaceViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
  }, [project.description, project.name]);

  const projectSections = sections[project.mode];
  const artifactCount = countProjectArtifacts(project);
  const workspaceFallback = (
    <div className="workspace-loading" role="status">
      <span className="status-dot" /> Loading {modeLabels[project.mode]} workspace…
    </div>
  );

  if (project.mode === "circuit") {
    return (
      <Suspense fallback={workspaceFallback}>
        <CircuitWorkspace onBack={onBack} onDelete={onDelete} onUpdateCircuit={onUpdateCircuit} project={project} />
      </Suspense>
    );
  }

  if (project.mode === "hdl") {
    return (
      <Suspense fallback={workspaceFallback}>
        <HDLWorkspace onBack={onBack} onDelete={onDelete} onUpdateHdl={onUpdateHdl} project={project} />
      </Suspense>
    );
  }

  if (project.mode === "x86") {
    return (
      <Suspense fallback={workspaceFallback}>
        <X86Workspace onBack={onBack} onDelete={onDelete} onUpdateX86={onUpdateX86} project={project} />
      </Suspense>
    );
  }

  if (project.mode === "mcu") {
    return (
      <Suspense fallback={workspaceFallback}>
        <MCUWorkspace onBack={onBack} onDelete={onDelete} onUpdateMcu={onUpdateMcu} project={project} />
      </Suspense>
    );
  }

  if (project.mode === "esp32") {
    return (
      <Suspense fallback={workspaceFallback}>
        <ESP32Workspace onBack={onBack} onDelete={onDelete} onUpdateEsp32={onUpdateEsp32} project={project} />
      </Suspense>
    );
  }

  if (project.mode === "experiments") {
    return (
      <Suspense fallback={workspaceFallback}>
        <ExperimentsWorkspace onBack={onBack} onDelete={onDelete} onUpdateExperiments={onUpdateExperiments} project={project} />
      </Suspense>
    );
  }

  function saveDetails() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    onUpdate(project.id, { name: trimmedName, description: description.trim() });
    setIsEditing(false);
  }

  return (
    <div className="workspace-page">
      <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> All projects</button>

      <section className="workspace-header">
        <div className="workspace-heading-copy">
          <div className="breadcrumb"><span>{modeLabels[project.mode]}</span><Icon name="chevron-right" size={14} /><span>Project</span></div>
          {isEditing ? (
            <input className="workspace-title-input" value={name} onChange={(event) => setName(event.target.value)} autoFocus aria-label="Project name" />
          ) : (
            <h1>{project.name}</h1>
          )}
          {isEditing ? (
            <textarea className="workspace-description-input" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} aria-label="Project description" />
          ) : (
            <p>{project.description || "Add a description to document the goal of this project."}</p>
          )}
        </div>
        <div className="workspace-header-actions">
          <span className="status-pill">Draft</span>
          {isEditing ? (
            <>
              <button className="button button-secondary" onClick={() => setIsEditing(false)} type="button">Cancel</button>
              <button className="button button-primary" onClick={saveDetails} type="button"><Icon name="save" size={16} /> Save</button>
            </>
          ) : (
            <button className="button button-secondary" onClick={() => setIsEditing(true)} type="button"><Icon name="settings" size={16} /> Edit details</button>
          )}
        </div>
      </section>

      <div className="workspace-meta-row">
        <span>Created {formatDate(project.createdAt)}</span>
        <span className="meta-separator" />
        <span>Last updated {formatDate(project.updatedAt)}</span>
        <span className="meta-spacer" />
        <span className="artifact-count"><Icon name="file" size={15} /> {artifactCount} saved {artifactCount === 1 ? "artifact" : "artifacts"}</span>
      </div>

      <section className="workspace-callout">
        <div className="callout-icon"><Icon name="layers" size={21} /></div>
        <div><strong>This lab is a preview</strong><p>{modeLabels[project.mode]} is not implemented yet. Projects can be created and stored, but no simulator, toolchain, or measurement is connected in this build. Nothing on this page produces simulated results.</p></div>
        <span className="status-pill status-planned">Preview</span>
      </section>

      <section className="content-section workspace-modules">
        <div className="section-heading"><div><span className="eyebrow">Workspace modules</span><h2>Planned capabilities</h2></div><span className="section-note">Not implemented yet</span></div>
        <div className="workspace-module-grid">
          {projectSections.map((section) => (
            <article className="workspace-module-card" key={section.title}>
              <div className="module-card-top"><span className="module-icon"><Icon name={section.icon} size={19} /></span><span className="module-status">{section.status}</span></div>
              <h3>{section.title}</h3>
              <p>{section.description}</p>
              <button className="module-link" disabled type="button">Not implemented yet <Icon name="chevron-right" size={15} /></button>
            </article>
          ))}
        </div>
      </section>

      <section className="workspace-danger-zone">
        <div><strong>Project actions</strong><p>Deleting a project removes its local workspace metadata.</p></div>
        <button className="button button-danger" onClick={() => onDelete(project.id)} type="button"><Icon name="trash" size={16} /> Delete project</button>
      </section>
    </div>
  );
}
