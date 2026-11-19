import type { FormEvent } from "react";
import { useState } from "react";
import { modeLabels, workspaceModes, type NewProjectInput, type WorkspaceMode } from "../types/project";
import { Icon } from "./Icon";

interface CreateProjectModalProps {
  initialMode: WorkspaceMode;
  onClose: () => void;
  onCreate: (input: NewProjectInput) => void;
}

export function CreateProjectModal({ initialMode, onClose, onCreate }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>(initialMode);
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();

    if (!trimmedName) {
      setError("Give the project a name before creating it.");
      return;
    }

    onCreate({
      name: trimmedName,
      description: description.trim(),
      mode,
    });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div aria-labelledby="create-project-title" aria-modal="true" className="modal-card" role="dialog">
        <div className="modal-header">
          <div>
            <span className="eyebrow">New workspace</span>
            <h2 id="create-project-title">Create a project</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog" type="button">
            <Icon name="x" size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label className="form-field">
            <span>Project name</span>
            <input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="e.g. MOD-4 Counter" />
          </label>

          <label className="form-field">
            <span>Workspace</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as WorkspaceMode)}>
              {workspaceModes.map((workspaceMode) => (
                <option key={workspaceMode} value={workspaceMode}>{modeLabels[workspaceMode]}</option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span>Description <small>Optional</small></span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What will you build or learn?" rows={3} />
          </label>

          {error ? <p className="form-error">{error}</p> : null}

          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">Cancel</button>
            <button className="button button-primary" type="submit"><Icon name="plus" size={16} /> Create project</button>
          </div>
        </form>
      </div>
    </div>
  );
}
