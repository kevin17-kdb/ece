import { useEffect, useMemo, useState } from "react";
import {
  defaultExperiment,
  experimentDefinitions,
  findExperiment,
  userSourceFor,
  type ExperimentDefinition,
  type ExperimentEvaluation,
} from "../lib/experiments";
import { modeLabels, type ExperimentDocument, type LabProject } from "../types/project";
import { CodeEditor } from "./CodeEditor";
import { Icon } from "./Icon";

interface ExperimentsWorkspaceProps {
  project: LabProject;
  onBack: () => void;
  onDelete: (projectId: string) => void;
  onUpdateExperiments: (projectId: string, experiments: ExperimentDocument) => void;
}

const engineLabels: Record<ExperimentDefinition["engine"], string> = {
  x86: "8086 assembly",
  mcu8051: "8051 assembly",
};

const difficultyLabels: Record<ExperimentDefinition["difficulty"], string> = {
  intro: "Intro",
  core: "Core",
  advanced: "Advanced",
};

function emptyDocument(): ExperimentDocument {
  return { activeId: "", sources: {}, completed: [] };
}

export function ExperimentsWorkspace({ project, onBack, onDelete, onUpdateExperiments }: ExperimentsWorkspaceProps) {
  const stored = project.documents.experiments ?? emptyDocument();
  const [activeId, setActiveId] = useState(() => stored.activeId || defaultExperiment.id);
  const [sources, setSources] = useState<Record<string, string>>(() => ({ ...stored.sources }));
  const [completed, setCompleted] = useState<string[]>(() => [...stored.completed]);
  const [evaluation, setEvaluation] = useState<ExperimentEvaluation | null>(null);

  useEffect(() => {
    const next = project.documents.experiments ?? emptyDocument();
    setActiveId(next.activeId || defaultExperiment.id);
    setSources({ ...next.sources });
    setCompleted([...next.completed]);
    setEvaluation(null);
  }, [project.id]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      onUpdateExperiments(project.id, {
        activeId,
        sources,
        completed,
      });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [activeId, completed, onUpdateExperiments, project.id, sources]);

  const definition = findExperiment(activeId);
  const source = userSourceFor({ sources }, definition);
  const solved = completed.includes(definition.id);
  const passedChecks = evaluation?.checks.filter((check) => check.passed).length ?? 0;
  const totalChecks = evaluation?.checks.length ?? 0;

  const groups = useMemo(() => {
    const order: ExperimentDefinition["engine"][] = ["x86", "mcu8051"];
    return order.map((engine) => ({
      engine,
      items: experimentDefinitions.filter((item) => item.engine === engine),
    }));
  }, []);

  function selectExperiment(id: string) {
    setActiveId(id);
    setEvaluation(null);
  }

  function updateSource(next: string) {
    setSources((current) => ({ ...current, [definition.id]: next }));
    setEvaluation(null);
  }

  function loadStarter() {
    if (source !== definition.starter && !window.confirm("Replace the current code with the starter?")) {
      return;
    }

    setSources((current) => ({ ...current, [definition.id]: definition.starter }));
    setEvaluation(null);
  }

  function runCheck() {
    const result = definition.evaluate(source);
    setEvaluation(result);
    if (result.compiled && result.checks.length > 0 && result.checks.every((check) => check.passed)) {
      setCompleted((current) => (current.includes(definition.id) ? current : [...current, definition.id]));
    }
  }

  function clearProgress() {
    if (!window.confirm("Reset every experiment to its starter and clear all completed checks?")) {
      return;
    }

    setSources({});
    setCompleted([]);
    setEvaluation(null);
  }

  return (
    <div className="x86-workspace">
      <div className="circuit-topbar">
        <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> All projects</button>
        <div className="circuit-breadcrumb"><span>{modeLabels.experiments}</span><Icon name="chevron-right" size={14} /><span>Guided lab</span></div>
      </div>

      <header className="circuit-header">
        <div>
          <span className="eyebrow">Guided experiments workspace</span>
          <h1>{project.name}</h1>
          <p>{project.description || "Work through guided tasks in real 8086 and 8051 programs, then let the checker run each one through the actual CPU simulator."}</p>
        </div>
        <div className="circuit-header-actions">
          <span className="status-pill">{completed.length}/{experimentDefinitions.length} solved</span>
          <button className="button button-secondary" onClick={clearProgress} type="button"><Icon name="refresh" size={16} /> Clear progress</button>
        </div>
      </header>

      <div className="exp-layout">
        <aside className="schematic-panel exp-library">
          <div className="schematic-panel-header">
            <div><strong>Experiment library</strong><span>{experimentDefinitions.length} guided labs</span></div>
          </div>
          {groups.map((group) => (
            <div className="exp-group" key={group.engine}>
              <span className="exp-group-title">{engineLabels[group.engine]}</span>
              {group.items.map((item) => (
                <button
                  className={`exp-item ${item.id === definition.id ? "is-active" : ""}`}
                  key={item.id}
                  onClick={() => selectExperiment(item.id)}
                  type="button"
                >
                  <span className="exp-item-title">{item.title}</span>
                  <span className="exp-item-meta">
                    <span className={`exp-difficulty exp-difficulty-${item.difficulty}`}>{difficultyLabels[item.difficulty]}</span>
                    {completed.includes(item.id) ? <span className="exp-solved"><Icon name="check" size={12} /> solved</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div className="exp-work">
          <section className="schematic-panel exp-brief">
            <div className="schematic-panel-header">
              <div>
                <strong>{definition.title}</strong>
                <span>{engineLabels[definition.engine]} · {difficultyLabels[definition.difficulty]}</span>
              </div>
              {solved ? <span className="status-pill status-ready">Solved</span> : <span className="status-pill">In progress</span>}
            </div>
            <p className="exp-summary">{definition.summary}</p>
            <div className="exp-brief-grid">
              <div>
                <span className="exp-section-title">Objectives</span>
                <ul className="exp-list">
                  {definition.objectives.map((objective) => <li key={objective}>{objective}</li>)}
                </ul>
              </div>
              <div>
                <span className="exp-section-title">Steps</span>
                <ol className="exp-list">
                  {definition.steps.map((step) => <li key={step}>{step}</li>)}
                </ol>
              </div>
            </div>
            <p className="exp-hint"><strong>Hint:</strong> {definition.hint}</p>
          </section>

          <section className="schematic-panel hdl-editor-panel">
            <div className="schematic-panel-header">
              <div><strong>{definition.engine === "x86" ? "solution.asm" : "solution.a51"}</strong><span>{source.split("\n").length} lines · {engineLabels[definition.engine]}</span></div>
              <div className="hdl-editor-actions">
                <button className="button button-secondary" onClick={loadStarter} type="button"><Icon name="file" size={16} /> Load starter</button>
                <button className="button button-primary" onClick={runCheck} type="button"><Icon name="play" size={16} /> Run &amp; check</button>
              </div>
            </div>
            <CodeEditor ariaLabel={`${definition.title} solution`} onChange={updateSource} value={source} />
          </section>

          <section className="simulation-results">
            <div className="simulation-results-header">
              <div><span className="eyebrow">Automatic checks</span><h2>Result</h2></div>
              <div className="simulation-header-actions">
                <span className="status-pill">{evaluation ? `${passedChecks}/${totalChecks} checks` : "Not run"}</span>
              </div>
            </div>
            <div className="simulation-body">
              <div className="simulation-output-panel">
                <div className="simulation-panel-title"><strong>Checklist</strong><span>run against the real {engineLabels[definition.engine]} simulator</span></div>
                {!evaluation ? (
                  <div className="simulation-empty">Write your program, then press "Run &amp; check" to evaluate it against the objectives.</div>
                ) : !evaluation.compiled ? (
                  <div className="issue-list">
                    <div className="issue-row issue-error"><span className="issue-code">assemble</span><span>{evaluation.error ?? "The program could not be assembled."}</span></div>
                  </div>
                ) : (
                  <div className="exp-checks">
                    {evaluation.checks.map((check) => (
                      <div className={`exp-check ${check.passed ? "is-pass" : "is-fail"}`} key={check.id}>
                        <span className="exp-check-icon"><Icon name={check.passed ? "check" : "x"} size={14} /></span>
                        <span className="exp-check-label">{check.label}</span>
                        <span className="exp-check-detail">{check.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="simulation-issues-panel">
                <div className="simulation-panel-title"><strong>Measured evidence</strong><span>values read from the simulator</span></div>
                {evaluation && evaluation.compiled && evaluation.evidence.length > 0 ? (
                  <ul className="exp-evidence">
                    {evaluation.evidence.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                ) : (
                  <div className="simulation-empty">Evidence appears here after a successful run.</div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>

      <section className="workspace-danger-zone circuit-danger-zone">
        <div><strong>Project actions</strong><p>Deleting a project removes its local workspace metadata.</p></div>
        <button className="button button-danger" onClick={() => onDelete(project.id)} type="button"><Icon name="trash" size={16} /> Delete project</button>
      </section>
    </div>
  );
}
