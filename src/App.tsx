import { useCallback, useEffect, useState } from "react";
import { CreateProjectModal } from "./components/CreateProjectModal";
import { Dashboard } from "./components/Dashboard";
import { Icon, type IconName } from "./components/Icon";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { WorkspaceView } from "./components/WorkspaceView";
import { loadProjects, makeProject, persistProjects } from "./lib/projectStore";
import { modeLabels, workspaceModes, type CircuitDocument, type ExperimentDocument, type HdlDocument, type LabProject, type McuDocument, type NewProjectInput, type ProjectDocuments, type WorkspaceMode, type X86Document } from "./types/project";
import "./styles.css";

function modeIcon(mode: WorkspaceMode): IconName {
  if (mode === "circuit") {
    return "circuit";
  }

  if (mode === "hdl") {
    return "code";
  }

  if (mode === "experiments") {
    return "flask";
  }

  return "cpu";
}

function App() {
  const [projects, setProjects] = useState<LabProject[]>(() => loadProjects());
  const [activeMode, setActiveMode] = useState<WorkspaceMode>("circuit");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  useEffect(() => {
    persistProjects(projects);
  }, [projects]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  const updateDocument = useCallback(<K extends keyof ProjectDocuments,>(projectId: string, key: K, value: NonNullable<ProjectDocuments[K]>) => {
    setProjects((currentProjects) => currentProjects.map((project) => {
      if (project.id !== projectId) {
        return project;
      }

      return {
        ...project,
        documents: { ...project.documents, [key]: value },
        updatedAt: new Date().toISOString(),
      };
    }));
  }, []);

  function openCreateModal() {
    setIsCreateOpen(true);
  }

  function handleCreateProject(input: NewProjectInput) {
    const project = makeProject(input);
    setProjects((currentProjects) => [project, ...currentProjects]);
    setSelectedProjectId(project.id);
    setActiveMode(project.mode);
    setSearch("");
    setIsCreateOpen(false);
  }

  function handleSelectMode(mode: WorkspaceMode) {
    setActiveMode(mode);
    setSelectedProjectId(null);
    setSearch("");
  }

  function handleSelectProject(project: LabProject) {
    setSelectedProjectId(project.id);
    setActiveMode(project.mode);
    setSearch("");
  }

  function handleDeleteProject(projectId: string) {
    const project = projects.find((currentProject) => currentProject.id === projectId);
    if (!project) {
      return;
    }

    if (!window.confirm(`Delete “${project.name}”?`)) {
      return;
    }

    setProjects((currentProjects) => currentProjects.filter((currentProject) => currentProject.id !== projectId));
    if (selectedProjectId === projectId) {
      setSelectedProjectId(null);
    }
  }

  const handleUpdateProject = useCallback((projectId: string, changes: Partial<Pick<LabProject, "name" | "description">>) => {
    setProjects((currentProjects) => currentProjects.map((project) => (
      project.id === projectId ? { ...project, ...changes, updatedAt: new Date().toISOString() } : project
    )));
  }, []);

  const handleUpdateCircuit = useCallback((projectId: string, circuit: CircuitDocument) => updateDocument(projectId, "circuit", circuit), [updateDocument]);
  const handleUpdateHdl = useCallback((projectId: string, hdl: HdlDocument) => updateDocument(projectId, "hdl", hdl), [updateDocument]);
  const handleUpdateX86 = useCallback((projectId: string, x86: X86Document) => updateDocument(projectId, "x86", x86), [updateDocument]);
  const handleUpdateMcu = useCallback((projectId: string, mcu: McuDocument) => updateDocument(projectId, "mcu", mcu), [updateDocument]);
  const handleUpdateEsp32 = useCallback((projectId: string, esp32: McuDocument) => updateDocument(projectId, "esp32", esp32), [updateDocument]);
  const handleUpdateExperiments = useCallback((projectId: string, experiments: ExperimentDocument) => updateDocument(projectId, "experiments", experiments), [updateDocument]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Icon name="circuit" size={20} /></div>
          <div><strong>Universal Electronics Lab</strong><span>Build what you want to understand</span></div>
        </div>

        <nav className="mode-tabs" aria-label="Workspaces">
          {workspaceModes.map((mode) => (
            <button className={`mode-tab ${activeMode === mode && !selectedProject ? "is-active" : ""}`} key={mode} onClick={() => handleSelectMode(mode)} type="button">
              <Icon name={modeIcon(mode)} size={15} />
              <span>{modeLabels[mode]}</span>
            </button>
          ))}
        </nav>

        <div className="topbar-actions">
          <span className="topbar-status"><span className="status-dot" /> Local workspace</span>
          <button className="button button-primary topbar-new-button" onClick={openCreateModal} type="button"><Icon name="plus" size={16} /> New project</button>
        </div>
      </header>

      <div className="app-body">
        <ProjectSidebar
          activeMode={activeMode}
          onCreate={openCreateModal}
          onDelete={handleDeleteProject}
          onSearchChange={setSearch}
          onSelect={handleSelectProject}
          projects={projects}
          search={search}
          selectedProjectId={selectedProjectId}
        />

        <main className="main-content">
          {selectedProject ? (
            <WorkspaceView onBack={() => setSelectedProjectId(null)} onDelete={handleDeleteProject} onUpdate={handleUpdateProject} onUpdateCircuit={handleUpdateCircuit} onUpdateEsp32={handleUpdateEsp32} onUpdateExperiments={handleUpdateExperiments} onUpdateHdl={handleUpdateHdl} onUpdateMcu={handleUpdateMcu} onUpdateX86={handleUpdateX86} project={selectedProject} />
          ) : (
            <Dashboard activeMode={activeMode} onCreateProject={openCreateModal} onOpenProject={handleSelectProject} onSelectMode={handleSelectMode} projects={projects} />
          )}
        </main>
      </div>

      {isCreateOpen ? <CreateProjectModal initialMode={activeMode} onClose={() => setIsCreateOpen(false)} onCreate={handleCreateProject} /> : null}
    </div>
  );
}

export default App;
