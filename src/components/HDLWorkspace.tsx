import { useEffect, useMemo, useRef, useState } from "react";
import { createCounterStarter, createFullAdderStarter, createHdlTemplate } from "../lib/hdlStarter";
import { captureVerilogWaveform, formatBusValue, type DigitalWaveform } from "../lib/waveform";
import { parseSources } from "../lib/verilog/parser";
import { simulateVerilog, type VerilogDiagnostic, type VerilogSimulationResult } from "../lib/verilog/simulator";
import { VerilogError } from "../lib/verilog/types";
import { toNumber } from "../lib/verilog/values";
import { modeLabels, type HdlDocument, type HdlFile, type LabProject } from "../types/project";
import { CodeEditor, type EditorMarker } from "./CodeEditor";
import { Icon } from "./Icon";
import { WaveformViewer } from "./WaveformViewer";

interface HDLWorkspaceProps {
  project: LabProject;
  onBack: () => void;
  onDelete: (projectId: string) => void;
  onUpdateHdl: (projectId: string, hdl: HdlDocument) => void;
}

interface RunState {
  result: VerilogSimulationResult | null;
  error: VerilogDiagnostic | null;
  elapsedMs: number;
}

const subsetHelp = [
  { title: "Modules", detail: "module / endmodule, named or ordered ports, parameter and localparam, #(...) overrides" },
  { title: "Signals", detail: "input, output, inout, wire, reg, integer, ranges [msb:lsb], bit and part selects" },
  { title: "Behavior", detail: "assign, initial, always @(...), always @*, always #delay, if, case, casez, for, while, repeat" },
  { title: "Expressions", detail: "arithmetic, bitwise, logical, comparison, concatenation, replication, $clog2" },
  { title: "Tasks", detail: "$display, $write, $monitor, $finish, $time with %b %d %h %o %s %t formats" },
];

const unsupported = "Not part of the subset: functions, tasks, generate, real, signed, forever, fork, wait, force, .* connections, SystemVerilog keywords.";

function emptyDocument(): HdlDocument {
  return { topModule: "", files: [] };
}

function getDocument(project: LabProject): HdlDocument {
  return project.documents.hdl ?? emptyDocument();
}

function uniquePath(files: HdlFile[], base: string): string {
  const candidate = (index: number): string => (index === 0 ? base : `${base.replace(/\.v$/, "")}_${index}.v`);
  let index = 0;
  while (files.some((file) => file.path === candidate(index))) {
    index += 1;
  }

  return candidate(index);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export function HDLWorkspace({ project, onBack, onDelete, onUpdateHdl }: HDLWorkspaceProps) {
  const [document, setDocument] = useState<HdlDocument>(() => getDocument(project));
  const [activePath, setActivePath] = useState<string>(() => getDocument(project).files[0]?.path ?? "");
  const [run, setRun] = useState<RunState>({ result: null, error: null, elapsedMs: 0 });
  const [hiddenSignals, setHiddenSignals] = useState<string[]>([]);
  const saveRef = useRef(onUpdateHdl);
  saveRef.current = onUpdateHdl;

  const activeFile = document.files.find((file) => file.path === activePath) ?? document.files[0] ?? null;

  useEffect(() => {
    const next = getDocument(project);
    setDocument(next);
    setActivePath(next.files[0]?.path ?? "");
    setRun({ result: null, error: null, elapsedMs: 0 });
    setHiddenSignals([]);
  }, [project.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => saveRef.current(project.id, document), 350);
    return () => window.clearTimeout(timer);
  }, [document, project.id]);

  const sources = useMemo(
    () => document.files.map((file) => ({ path: file.path, content: file.content })),
    [document.files],
  );

  const moduleNames = useMemo(() => {
    try {
      return parseSources(sources).modules.map((module) => module.name);
    } catch {
      return [];
    }
  }, [sources]);

  const diagnostics: VerilogDiagnostic[] = [
    ...(run.error ? [run.error] : []),
    ...(run.result?.diagnostics ?? []),
  ];

  const markers: EditorMarker[] = useMemo(
    () => diagnostics
      .filter((diagnostic) => diagnostic.file === activeFile?.path && diagnostic.line)
      .map((diagnostic) => ({ line: diagnostic.line as number, severity: diagnostic.severity })),
    [activeFile?.path, diagnostics],
  );

  const waveform: DigitalWaveform | null = useMemo(() => {
    if (!run.result || run.result.samples.length === 0 || run.result.signals.length === 0) {
      return null;
    }

    return captureVerilogWaveform(run.result, { maxSamples: 2000 });
  }, [run.result]);

  const visibleSignals = useMemo(
    () => (run.result?.signals ?? []).filter((signal) => !hiddenSignals.includes(signal.path)),
    [hiddenSignals, run.result],
  );

  const visibleWaveform: DigitalWaveform | null = useMemo(() => {
    if (!waveform || visibleSignals.length === 0) {
      return waveform;
    }

    return { ...waveform, signals: waveform.signals.filter((signal) => visibleSignals.some((candidate) => candidate.path === signal.id)) };
  }, [visibleSignals, waveform]);

  function commit(next: HdlDocument) {
    setDocument(next);
  }

  function updateFileContent(content: string) {
    commit({ ...document, files: document.files.map((file) => (file.path === activeFile?.path ? { ...file, content } : file)) });
  }

  function addFile(kind: "rtl" | "testbench") {
    const path = uniquePath(document.files, kind === "rtl" ? "rtl/new_module.v" : "tb/tb_new_module.v");
    const language = kind === "rtl" ? "verilog" : "testbench";
    const moduleName = kind === "rtl" ? "new_module" : "tb_new_module";
    const content = kind === "rtl"
      ? `module new_module (\n  input wire a,\n  input wire b,\n  output wire y\n);\n\n  assign y = a ^ b;\n\nendmodule\n`
      : `\`timescale 1ns / 1ps\n\nmodule ${moduleName};\n\n  reg a;\n  reg b;\n  wire y;\n\n  new_module dut (\n    .a(a),\n    .b(b),\n    .y(y)\n  );\n\n  initial begin\n    a = 1'b0;\n    b = 1'b0;\n    #1 $display("y = %b", y);\n    $finish;\n  end\n\nendmodule\n`;
    commit({ ...document, files: [...document.files, { path, language, content }] });
    setActivePath(path);
  }

  function deleteFile(path: string) {
    const files = document.files.filter((file) => file.path !== path);
    commit({ ...document, files });
    if (activePath === path) {
      setActivePath(files[0]?.path ?? "");
    }
  }

  function loadStarter(kind: "template" | "adder" | "counter") {
    const next = kind === "adder" ? createFullAdderStarter() : kind === "counter" ? createCounterStarter() : createHdlTemplate();
    if (document.files.length > 0 && !window.confirm(`Replace the ${document.files.length} current file${document.files.length === 1 ? "" : "s"} with the ${kind} example?`)) {
      return;
    }

    commit(next);
    setActivePath(next.files[0]?.path ?? "");
    setRun({ result: null, error: null, elapsedMs: 0 });
    setHiddenSignals([]);
  }

  function runSimulation() {
    if (document.files.length === 0) {
      return;
    }

    const startedAt = performance.now();
    try {
      const result = simulateVerilog(sources, {
        topModule: document.topModule,
        maxSignals: 24,
        maxSamples: 2000,
      });
      setRun({ result, error: null, elapsedMs: performance.now() - startedAt });
    } catch (error) {
      if (error instanceof VerilogError) {
        setRun({
          result: null,
          error: { severity: "error", message: error.message, file: error.range.file, line: error.range.line, column: error.range.column },
          elapsedMs: performance.now() - startedAt,
        });
        return;
      }

      setRun({
        result: null,
        error: { severity: "error", message: error instanceof Error ? error.message : String(error) },
        elapsedMs: performance.now() - startedAt,
      });
    }
  }

  function toggleSignal(path: string) {
    setHiddenSignals((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  }

  function jumpToDiagnostic(diagnostic: VerilogDiagnostic) {
    if (!diagnostic.file) {
      return;
    }

    setActivePath(diagnostic.file);
  }

  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const status = run.error || (run.result && !run.result.ok) ? "error" : run.result ? "ready" : "idle";

  return (
    <div className="hdl-workspace">
      <div className="circuit-topline">
        <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> All projects</button>
        <div className="circuit-breadcrumb"><span>{modeLabels.hdl}</span><Icon name="chevron-right" size={14} /><span>Sources</span></div>
      </div>

      <header className="circuit-header">
        <div>
          <span className="eyebrow">Verilog subset workspace</span>
          <h1>{project.name}</h1>
          <p>{project.description || "Write RTL and a self-checking testbench, then run the event-driven engine."}</p>
        </div>
        <div className="circuit-header-actions">
          <button className="button button-secondary" onClick={() => loadStarter("counter")} type="button"><Icon name="grid" size={16} /> Clocked example</button>
          <button className="button button-secondary" onClick={() => loadStarter("adder")} type="button"><Icon name="layers" size={16} /> Full adder</button>
          <button className="button button-primary" disabled={document.files.length === 0} onClick={runSimulation} type="button"><Icon name="play" size={16} /> Run simulation</button>
        </div>
      </header>

      <div className="circuit-toolbar">
        <div className="circuit-toolbar-group">
          <span className="toolbar-label">Top module</span>
          <select className="hdl-top-select" onChange={(event) => commit({ ...document, topModule: event.target.value })} value={document.topModule}>
            <option value="">Detect automatically</option>
            {moduleNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div className="circuit-toolbar-group"><span className="toolbar-label">Files</span><span className="toolbar-value">{document.files.length}</span></div>
        {run.result ? <div className="circuit-toolbar-group"><span className="toolbar-label">Elapsed</span><span className="toolbar-value">{run.result.elapsedTimeNs} {run.result.timeUnitLabel}</span></div> : null}
        <div className="circuit-toolbar-spacer" />
        <div className={`simulation-health ${status === "error" ? "has-errors" : "is-ready"}`}><span className="status-dot" /> {status === "error" ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : run.result ? "Simulation complete" : "Not run yet"}{warningCount > 0 ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}</div>
      </div>

      <div className="circuit-layout hdl-layout">
        <aside className="component-palette">
          <div className="panel-heading"><div><span className="eyebrow">Project</span><h2>Source files</h2></div><span className="palette-count">{document.files.length}</span></div>
          <div className="hdl-file-actions">
            <button className="button button-secondary" onClick={() => addFile("rtl")} type="button"><Icon name="plus" size={14} /> RTL file</button>
            <button className="button button-secondary" onClick={() => addFile("testbench")} type="button"><Icon name="plus" size={14} /> Testbench</button>
          </div>
          <div className="hdl-file-list">
            {document.files.length === 0 ? <div className="inspector-empty"><p>Add an RTL file and a testbench to start.</p></div> : document.files.map((file) => {
              const fileDiagnostics = diagnostics.filter((diagnostic) => diagnostic.file === file.path);
              const hasError = fileDiagnostics.some((diagnostic) => diagnostic.severity === "error");
              return (
                <button className={`hdl-file ${file.path === activeFile?.path ? "is-selected" : ""} ${hasError ? "has-error" : ""}`} key={file.path} onClick={() => setActivePath(file.path)} type="button">
                  <Icon name={file.language === "testbench" ? "flask" : "code"} size={14} />
                  <span><strong>{file.path.split("/").pop()}</strong><small>{file.path}</small></span>
                  {fileDiagnostics.length > 0 ? <span className="hdl-file-badge">{fileDiagnostics.length}</span> : null}
                </button>
              );
            })}
          </div>
          <button className="palette-tip" onClick={() => loadStarter("template")} type="button"><Icon name="activity" size={15} /><span>Reset to the starter testbench.</span></button>
        </aside>

        <section className="schematic-panel hdl-editor-panel">
          <div className="schematic-panel-header">
            <div><strong>{activeFile?.path ?? "No file selected"}</strong><span>{activeFile ? `${activeFile.content.split("\n").length} lines · ${activeFile.language}` : "Add a file from the panel"}</span></div>
            <div className="hdl-editor-actions">
              {activeFile ? <button className="toolbar-icon-button" aria-label="Delete this file" onClick={() => deleteFile(activeFile.path)} title="Delete this file" type="button"><Icon name="trash" size={14} /></button> : null}
              <span className="canvas-mode-label"><span className="status-dot" /> Autosaved</span>
            </div>
          </div>
          {activeFile ? <CodeEditor ariaLabel={`${activeFile.path} source`} markers={markers} onChange={updateFileContent} value={activeFile.content} /> : <div className="canvas-empty"><div className="canvas-empty-icon"><Icon name="code" size={25} /></div><strong>No source file open</strong><span>Add an RTL file or load the starter testbench.</span></div>}
          <div className="schematic-panel-footer"><span><Icon name="save" size={14} /> Changes save automatically</span><span><Icon name="code" size={14} /> Tab indents, Enter continues the block</span><span><Icon name="activity" size={14} /> Errors are marked in the gutter</span></div>
        </section>

        <aside className="circuit-inspector">
          <div className="panel-heading"><div><span className="eyebrow">Inspector</span><h2>Simulated signals</h2></div>{run.result ? <span className="inspector-id">{run.result.signals.length}</span> : null}</div>
          {run.result && run.result.signals.length > 0 ? (
            <div className="inspector-content">
              <p className="palette-help">Hide a signal to focus the trace. Hidden signals are not plotted.</p>
              <div className="hdl-signal-list">
                {run.result.signals.map((signal) => {
                  const value = run.result?.finalValues[signal.path] ?? "";
                  return (
                    <label className={`hdl-signal-row ${hiddenSignals.includes(signal.path) ? "is-hidden" : ""}`} key={signal.path}>
                      <input checked={!hiddenSignals.includes(signal.path)} onChange={() => toggleSignal(signal.path)} type="checkbox" />
                      <span className="hdl-signal-copy"><strong>{signal.path}</strong><small>{signal.width > 1 ? `[${signal.width - 1}:0]` : "1 bit"}</small></span>
                      <span className={`digital-value ${signalValueClass(value)}`}>{formatBusValue(value, signal.width)}</span>
                    </label>
                  );
                })}
              </div>
              {run.result.scopeNames.length > 0 ? <div className="pin-list"><span className="inspector-section-label">Scopes</span>{run.result.scopeNames.map((scope) => <div className="pin-list-row" key={scope}><span>{scope}</span></div>)}</div> : null}
            </div>
          ) : (
            <div className="inspector-empty"><div className="inspector-empty-icon"><Icon name="activity" size={21} /></div><strong>No run yet</strong><p>Run the simulation to see captured signal values.</p></div>
          )}
        </aside>
      </div>

      <section className="simulation-results">
        <div className="simulation-results-header">
          <div><span className="eyebrow">Event-driven engine</span><h2>Console and diagnostics</h2></div>
          <div className="simulation-header-actions">
            <span className="status-pill">{run.result ? `${run.result.log.length} log lines · ${run.elapsedMs.toFixed(1)} ms` : "Not run"}</span>
            {run.result?.truncated ? <span className="status-pill">Trace truncated at the sample limit</span> : null}
          </div>
        </div>
        <div className="simulation-body">
          <div className="simulation-output-panel">
            <div className="simulation-panel-title"><strong>Console</strong><span>$display, $write, $monitor</span></div>
            {run.result && run.result.log.length > 0 ? <pre className="hdl-console">{run.result.log.map((entry, index) => <span className={`hdl-console-line hdl-console-${entry.kind}`} key={`${entry.timeNs}-${index}`}><span className="hdl-console-time">[{entry.timeNs} {run.result?.timeUnitLabel}]</span>{entry.text}</span>)}</pre> : <div className="simulation-empty">Run the simulation to collect $display output.</div>}
          </div>
          <div className="simulation-issues-panel">
            <div className="simulation-panel-title"><strong>Diagnostics</strong><span>{diagnostics.length} messages</span></div>
            {diagnostics.length > 0 ? <div className="issue-list">{diagnostics.map((diagnostic, index) => (
              <button className={`issue-row issue-${diagnostic.severity}`} key={`${diagnostic.file}-${diagnostic.line}-${index}`} onClick={() => jumpToDiagnostic(diagnostic)} type="button">
                <span className="issue-code">{diagnostic.file ? `${diagnostic.file.split("/").pop()}:${diagnostic.line ?? 0}` : "general"}</span>
                <span>{diagnostic.message}</span>
              </button>
            ))}</div> : <div className="simulation-empty success-empty"><Icon name="check" size={17} /> No diagnostics from the last run.</div>}
          </div>
        </div>
      </section>

      {visibleWaveform ? <WaveformViewer waveform={visibleWaveform} /> : null}

      <section className="hdl-help-panel">
        <div className="simulation-results-header"><div><span className="eyebrow">Reference</span><h2>Supported Verilog subset</h2></div></div>
        <div className="hdl-help-grid">
          {subsetHelp.map((entry) => <div className="hdl-help-card" key={entry.title}><strong>{entry.title}</strong><p>{entry.detail}</p></div>)}
        </div>
        <p className="hdl-help-note">{unsupported}</p>
      </section>

      <section className="workspace-danger-zone circuit-danger-zone"><div><strong>Project actions</strong><p>Updated {formatDate(project.updatedAt)} · Changes are stored locally in this project.</p></div><button className="button button-danger" onClick={() => onDelete(project.id)} type="button"><Icon name="trash" size={16} /> Delete project</button></section>
    </div>
  );
}

function signalValueClass(value: string): string {
  if (/[xz]/i.test(value)) {
    return "digital-x";
  }

  const number = toNumber(value);
  if (number === null) {
    return "digital-x";
  }

  return number === 0n ? "digital-0" : "digital-1";
}
