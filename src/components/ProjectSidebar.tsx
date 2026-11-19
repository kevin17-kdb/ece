import { getProjectProgress } from "../lib/projectStore";
import { modeLabels, type LabProject, type WorkspaceMode } from "../types/project";
import { Icon } from "./Icon";

interface ProjectSidebarProps {
  projects: LabProject[];
  activeMode: WorkspaceMode;
  selectedProjectId: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (project: LabProject) => void;
  onCreate: () => void;
  onDelete: (projectId: string) => void;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

export function ProjectSidebar({
  projects,
  activeMode,
  selectedProjectId,
  search,
  onSearchChange,
  onSelect,
  onCreate,
  onDelete,
}: ProjectSidebarProps) {
  const labImplemented = activeMode === "circuit" || activeMode === "hdl" || activeMode === "x86" || activeMode === "mcu" || activeMode === "esp32" || activeMode === "experiments";
  const normalizedSearch = search.trim().toLowerCase();
  const visibleProjects = projects.filter((project) => {
    const matchesMode = project.mode === activeMode;
    const matchesSearch =
      normalizedSearch.length === 0 ||
      project.name.toLowerCase().includes(normalizedSearch) ||
      project.description.toLowerCase().includes(normalizedSearch);

    return matchesMode && matchesSearch;
  });

  return (
    <aside className="project-sidebar">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>{modeLabels[activeMode]}</h2>
        </div>
        <button className="icon-button" onClick={onCreate} aria-label="Create project" title="Create project">
          <Icon name="plus" size={17} />
        </button>
      </div>

      <label className="search-field">
        <Icon name="search" size={16} />
        <span className="sr-only">Search projects</span>
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search projects"
          type="search"
        />
      </label>

      <div className="sidebar-section-label">
        <span>Projects</span>
        <span className="count-badge">{visibleProjects.length}</span>
      </div>

      <div className="project-list">
        {visibleProjects.length > 0 ? (
          visibleProjects.map((project) => (
            <div className={`project-list-item ${selectedProjectId === project.id ? "is-selected" : ""}`} key={project.id}>
              <button className="project-select" onClick={() => onSelect(project)} type="button">
                <span className="project-icon"><Icon name={project.mode === "circuit" ? "circuit" : project.mode === "hdl" ? "code" : project.mode === "x86" ? "cpu" : project.mode === "mcu" ? "cpu" : project.mode === "esp32" ? "cpu" : "flask"} size={16} /></span>
                <span className="project-list-copy">
                  <strong>{project.name}</strong>
                  <small>{getProjectProgress(project).statusLabel} · Edited {formatDate(project.updatedAt)}</small>
                </span>
                <Icon name="chevron-right" size={15} />
              </button>
              <button
                className="project-delete"
                onClick={() => onDelete(project.id)}
                aria-label={`Delete ${project.name}`}
                title={`Delete ${project.name}`}
                type="button"
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))
        ) : (
          <div className="sidebar-empty">
            <Icon name="folder" size={22} />
            <p>No projects in this workspace yet.</p>
            <button className="text-button" onClick={onCreate} type="button">Create the first one</button>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="status-line"><span className="status-dot" /> Local project storage</div>
        <span className="sidebar-footer-note">{labImplemented ? "Simulator implemented" : "Preview — no simulator yet"}</span>
      </div>
    </aside>
  );
}
