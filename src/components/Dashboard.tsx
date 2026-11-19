import { getProjectProgress } from "../lib/projectStore";
import type { LabProject, WorkspaceMode } from "../types/project";
import { modeLabels, workspaceModes } from "../types/project";
import { Icon, type IconName } from "./Icon";

interface DashboardProps {
  activeMode: WorkspaceMode;
  projects: LabProject[];
  onCreateProject: () => void;
  onOpenProject: (project: LabProject) => void;
  onSelectMode: (mode: WorkspaceMode) => void;
}

interface ModeDetails {
  icon: IconName;
  eyebrow: string;
  title: string;
  description: string;
  features: string[];
  accent: string;
  available: boolean;
}

const modeDetails: Record<WorkspaceMode, ModeDetails> = {
  circuit: {
    icon: "circuit",
    eyebrow: "Design and simulate",
    title: "Circuit Lab",
    description: "Place symbols, wire nets, and run the deterministic digital engine on gates, flip-flops, counters, and 74xx logic.",
    features: ["Schematic canvas", "Digital simulation", "Netlist export"],
    accent: "cyan",
    available: true,
  },
  hdl: {
    icon: "code",
    eyebrow: "Write and verify",
    title: "Digital / HDL",
    description: "Write Verilog RTL and testbenches, run the event-driven engine, and inspect captured waveforms.",
    features: ["Verilog subset editor", "Testbenches", "Waveform traces"],
    accent: "violet",
    available: true,
  },
  x86: {
    icon: "cpu",
    eyebrow: "Step through code",
    title: "8086 Lab",
    description: "Assemble, execute, and debug 8086 programs with live registers, flags, memory, and I/O.",
    features: ["Assembly editor", "CPU debugger", "Memory and ports"],
    accent: "amber",
    available: true,
  },
  mcu: {
    icon: "cpu",
    eyebrow: "Assemble and run",
    title: "MCU Lab",
    description: "Write 8051 assembly, assemble it to machine code, and run or step the CPU with registers, flags, ports, RAM, and a serial console.",
    features: ["8051 assembler", "CPU debugger", "Ports and RAM"],
    accent: "green",
    available: true,
  },
  esp32: {
    icon: "cpu",
    eyebrow: "Assemble and run RISC-V",
    title: "ESP32 Lab",
    description: "Write ESP32-C3 RISC-V assembly, assemble it to machine code, and run or step the CPU with registers, GPIO output, and a UART console.",
    features: ["RV32I assembler", "CPU debugger", "GPIO and UART"],
    accent: "blue",
    available: true,
  },
  experiments: {
    icon: "flask",
    eyebrow: "Learn by doing",
    title: "Experiments",
    description: "Work through guided 8086 and 8051 tasks, then let automatic checks evaluate your code on the real CPU simulators.",
    features: ["Guided labs", "Automatic checks", "Progress tracking"],
    accent: "pink",
    available: true,
  },
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function ProjectCard({ project, onOpen }: { project: LabProject; onOpen: () => void }) {
  const details = modeDetails[project.mode];
  const progress = getProjectProgress(project);

  return (
    <button className="project-card" onClick={onOpen} type="button">
      <span className={`project-card-icon accent-${details.accent}`}><Icon name={details.icon} size={19} /></span>
      <span className="project-card-copy">
        <span className="project-card-topline"><strong>{project.name}</strong><span className={`status-pill status-${progress.status}`}>{progress.statusLabel}</span></span>
        <span className="project-card-description">{project.description || "No description yet."}</span>
        <span className="project-card-meta">
          <span>{modeLabels[project.mode]}</span>
          <span>{progress.status === "planned" ? "Preview" : `${progress.artifactCount} ${progress.artifactCount === 1 ? "item" : "items"}`}</span>
          <span>Edited {formatDate(project.updatedAt)}</span>
        </span>
      </span>
      <Icon name="chevron-right" size={18} />
    </button>
  );
}

export function Dashboard({ activeMode, projects, onCreateProject, onOpenProject, onSelectMode }: DashboardProps) {
  const details = modeDetails[activeMode];
  const activeProjects = projects.filter((project) => project.mode === activeMode);

  return (
    <div className="dashboard-page">
      <section className="content-section">
        <div className="section-heading">
          <div><span className="eyebrow">Your workspace</span><h2>{modeLabels[activeMode]} projects</h2></div>
          <button className="text-button" onClick={onCreateProject} type="button">Create project <Icon name="plus" size={15} /></button>
        </div>
        {activeProjects.length > 0 ? (
          <div className="project-grid">
            {activeProjects.slice(0, 6).map((project) => <ProjectCard key={project.id} onOpen={() => onOpenProject(project)} project={project} />)}
          </div>
        ) : (
          <div className="empty-projects">
            <div className="empty-projects-icon"><Icon name="folder" size={26} /></div>
            <div><h3>No {details.title} projects yet</h3><p>Create a project to reserve a workspace for your next experiment.</p></div>
            <button className="button button-secondary" onClick={onCreateProject} type="button">Create project</button>
          </div>
        )}
      </section>

      <section className="content-section">
        <div className="section-heading"><div><span className="eyebrow">Platform map</span><h2>Choose a lab</h2></div><span className="section-note">{projects.length} total projects</span></div>
        <div className="mode-grid">
          {workspaceModes.map((mode) => {
            const modeInfo = modeDetails[mode];
            const count = projects.filter((project) => project.mode === mode).length;
            return (
              <button className={`mode-card ${mode === activeMode ? "is-active" : ""}`} key={mode} onClick={() => onSelectMode(mode)} type="button">
                <span className={`mode-card-icon accent-${modeInfo.accent}`}><Icon name={modeInfo.icon} size={20} /></span>
                <span className="mode-card-copy">
                  <strong>{modeInfo.title}</strong>
                  <small>{modeInfo.available ? `${count} ${count === 1 ? "project" : "projects"}` : "Preview — not implemented"}</small>
                </span>
                <span className={`lab-status lab-status-${modeInfo.available ? "ready" : "preview"}`}>{modeInfo.available ? "Ready" : "Preview"}</span>
                <Icon name="chevron-right" size={17} />
              </button>
            );
          })}
        </div>
      </section>

      <section className="foundation-note">
        <div className="foundation-note-icon"><Icon name="layers" size={20} /></div>
        <div>
          <strong>All five labs are functional</strong>
          <p>Projects, navigation, local persistence, the digital circuit engine, the Verilog subset, the 8086 CPU, an 8051 assembly subset, and the guided Experiments runner are all implemented on real simulators.</p>
        </div>
        <span className="status-pill status-pill-green">Local storage</span>
      </section>
    </div>
  );
}
