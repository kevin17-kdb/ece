import { useEffect, useMemo, useRef, useState } from "react";
import { assemble } from "../lib/esp32/assembler";
import { createMachine, createState, runMachine, stepMachine, type Esp32Machine } from "../lib/esp32/simulator";
import {
  esp32AbiNames,
  esp32RegisterNames,
  type Esp32Assembly,
  type Esp32Diagnostic,
  type Esp32RunResult,
  type Esp32State,
  type Esp32Step,
} from "../lib/esp32/types";
import { createEsp32Template, esp32StarterPrograms, getEsp32Source } from "../lib/esp32Starter";
import { captureEsp32Waveform } from "../lib/waveform";
import { modeLabels, type LabProject, type McuDocument } from "../types/project";
import { CodeEditor, type EditorMarker } from "./CodeEditor";
import { Icon } from "./Icon";
import { WaveformViewer } from "./WaveformViewer";

interface ESP32WorkspaceProps {
  project: LabProject;
  onBack: () => void;
  onDelete: (projectId: string) => void;
  onUpdateEsp32: (projectId: string, esp32: McuDocument) => void;
}

const helpEntries = [
  { title: "Arithmetic & logic", detail: "add, sub, and, or, xor (R-type); addi (I-type)." },
  { title: "Shifts", detail: "slli and srli shift a register by an immediate amount (0–31)." },
  { title: "Load / store", detail: "lw, lb, lbu and sw, sb with an offset(base) address operand." },
  { title: "Upper immediate", detail: "lui loads a 20-bit constant into the upper bits of a register." },
  { title: "Control flow", detail: "beq, bne, blt, bge branches; jal/j and jalr jumps. j label and li with a numeric constant are pseudo-instructions." },
  { title: "System", detail: "ebreak and ecall halt the machine. ret returns via ra (jalr x0, ra, 0)." },
];

function byteHex(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export function ESP32Workspace({ project, onBack, onDelete, onUpdateEsp32 }: ESP32WorkspaceProps) {
  const [source, setSource] = useState(() => getEsp32Source(project.documents.esp32));
  const [machine, setMachine] = useState<Esp32Machine | null>(null);
  const [steps, setSteps] = useState<Esp32Step[]>([]);
  const [run, setRun] = useState<Esp32RunResult | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [gpioInputs, setGpioInputs] = useState(0xff);
  const [memoryBase, setMemoryBase] = useState("0000");
  const [pendingStarter, setPendingStarter] = useState(esp32StarterPrograms[0].id);

  const machineRef = useRef<Esp32Machine | null>(null);
  machineRef.current = machine;

  useEffect(() => {
    setSource(getEsp32Source(project.documents.esp32));
    setMachine(null);
    setSteps([]);
    setRun(null);
    setRuntimeError(null);
    setGpioInputs(0xff);
  }, [project.id]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      onUpdateEsp32(project.id, createEsp32Template(source));
    }, 400);
    return () => window.clearTimeout(handle);
  }, [onUpdateEsp32, project.id, source]);

  const assembly: Esp32Assembly | null = useMemo(() => {
    try {
      return assemble(source);
    } catch (error) {
      return {
        bytes: [],
        origin: 0,
        entryPoint: 0,
        codeEnd: 0,
        listing: [],
        symbols: [],
        diagnostics: [{ severity: "error", message: error instanceof Error ? error.message : String(error), line: 0 }],
      };
    }
  }, [source]);

  const errors = useMemo(
    () => (assembly?.diagnostics ?? []).filter((diagnostic): diagnostic is Esp32Diagnostic => diagnostic.severity === "error"),
    [assembly],
  );

  const markers: EditorMarker[] = useMemo(
    () => errors.map((diagnostic) => ({ line: diagnostic.line, severity: diagnostic.severity })),
    [errors],
  );

  const state: Esp32State = machine?.state ?? run?.finalState ?? createState();
  const trace = run?.trace ?? steps;
  const waveform = useMemo(() => (trace.length > 0 ? captureEsp32Waveform(trace, { maxSamples: 2000 }) : null), [trace]);

  function createSession(): Esp32Machine {
    const created = createMachine(assembly ?? assemble(source));
    created.state.gpioIn = gpioInputs & 0xff;
    return created;
  }

  function commitSource(next: string) {
    setSource(next);
    setMachine(null);
    setSteps([]);
    setRun(null);
    setRuntimeError(null);
  }

  function resetMachine() {
    setMachine(null);
    setSteps([]);
    setRun(null);
    setRuntimeError(null);
  }

  function loadStarter(id: string) {
    const program = esp32StarterPrograms.find((entry) => entry.id === id);
    if (!program) {
      return;
    }

    if (source.trim().length > 0 && !window.confirm("Replace the current program?")) {
      return;
    }

    commitSource(program.source);
  }

  function doStep() {
    if (errors.length > 0) {
      return;
    }

    const active = machine ?? createSession();
    try {
      const step = stepMachine(active, steps.length);
      setSteps((current) => [...current, step]);
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    }

    setMachine({ ...active });
  }

  function runProgram() {
    if (errors.length > 0) {
      return;
    }

    const active = createSession();
    const result = runMachine(active, { stepLimit: 50000 });
    setRun(result);
    setMachine(null);
    setSteps([]);
    setRuntimeError(result.error ?? null);
  }

  function toggleGpioBit(bit: number) {
    setGpioInputs((current) => current ^ (1 << bit));
  }

  const registerNames = ["ra", "sp", "s0", "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "t0", "t1", "t2"];
  const registers: Array<{ label: string; value: string }> = [
    { label: "PC", value: (state.pc >>> 0).toString(16).toUpperCase().padStart(8, "0") },
    ...registerNames.map((name) => ({ label: name.toUpperCase(), value: (state.registers[esp32RegisterNames[name]] >>> 0).toString(16).toUpperCase().padStart(8, "0") })),
  ];

  const parsedBase = Number.parseInt(memoryBase.replace(/[^0-9a-fA-F]/g, ""), 16);
  const memoryBaseValue = Math.min((Number.isFinite(parsedBase) ? parsedBase : 0) & 0xfff0, 0xff80);

  function showMemoryPage(offset: number) {
    const next = Math.max(0, Math.min(0xff80, memoryBaseValue + offset));
    setMemoryBase(next.toString(16).toUpperCase().padStart(4, "0"));
  }

  const statusLabel = runtimeError
    ? "Runtime error"
    : run
      ? run.haltReason === "halted" ? "Halted" : run.haltReason === "terminated" ? "Terminated" : run.haltReason === "step-limit" ? "Step limit" : "Error"
      : machine ? "Paused" : "Not run";

  return (
    <div className="x86-workspace">
      <div className="circuit-topbar">
        <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> All projects</button>
        <div className="circuit-breadcrumb"><span>{modeLabels.esp32}</span><Icon name="chevron-right" size={14} /><span>ESP32-C3 RISC-V assembly</span></div>
      </div>

      <header className="circuit-header">
        <div>
          <span className="eyebrow">ESP32-C3 microcontroller workspace</span>
          <h1>{project.name}</h1>
          <p>{project.description || "Write ESP32-C3 RV32I assembly, assemble it into machine code, and run or step the CPU while watching registers, GPIO output and the UART console."}</p>
        </div>
        <div className="circuit-header-actions">
          <button className="button button-secondary" onClick={() => loadStarter(pendingStarter)} type="button"><Icon name="file" size={16} /> Load example</button>
          <button className="button button-secondary" onClick={doStep} type="button"><Icon name="play" size={16} /> Step</button>
          <button className="button button-primary" disabled={errors.length > 0} onClick={runProgram} type="button"><Icon name="play" size={16} /> Run</button>
        </div>
      </header>

      <div className="circuit-toolbar">
        <div className="circuit-toolbar-group"><span className="toolbar-label">Status</span><span className="toolbar-value">{statusLabel}</span></div>
        <div className="circuit-toolbar-group"><span className="toolbar-label">PC</span><span className="toolbar-value">{(state.pc >>> 0).toString(16).toUpperCase().padStart(8, "0")}h</span></div>
        <div className="circuit-toolbar-group"><span className="toolbar-label">Steps</span><span className="toolbar-value">{run?.steps ?? steps.length}</span></div>
        <div className="circuit-toolbar-spacer" />
        <button className="toolbar-icon-button" aria-label="Reset the machine" onClick={resetMachine} type="button" title="Reset the machine"><Icon name="trash" size={15} /></button>
        <div className={`simulation-health ${errors.length > 0 ? "has-errors" : "is-ready"}`}><span className="status-dot" /> {errors.length > 0 ? `${errors.length} error${errors.length === 1 ? "" : "s"}` : "Assembled"}</div>
      </div>

      <div className="circuit-layout hdl-layout x86-layout">
        <section className="schematic-panel hdl-editor-panel">
          <div className="schematic-panel-header">
            <div><strong>main.s</strong><span>{source.split("\n").length} lines · RISC-V RV32I assembly</span></div>
            <div className="hdl-editor-actions">
              <select
                aria-label="Example program"
                className="x86-memory-input"
                onChange={(event) => setPendingStarter(event.target.value)}
                value={pendingStarter}
              >
                {esp32StarterPrograms.map((program) => (
                  <option key={program.id} value={program.id}>{program.name}</option>
                ))}
              </select>
            </div>
          </div>
          <CodeEditor ariaLabel="ESP32 assembly source" markers={markers} onChange={commitSource} value={source} />
        </section>

        <section className="schematic-panel x86-listing-panel">
          <div className="schematic-panel-header">
            <div><strong>Listing</strong><span>{assembly?.listing?.length ?? 0} instructions · program counter highlighted</span></div>
          </div>
          <div className="x86-listing">
            {(assembly?.listing?.length ?? 0) === 0 ? (
              <div className="simulation-empty">Assemble a program to see the machine code.</div>
            ) : (
              assembly?.listing.map((entry) => (
                <div className={`x86-listing-row ${entry.address === state.pc ? "is-current" : ""}`} key={`${entry.address}-${entry.line}`}>
                  <span className="x86-breakpoint" aria-hidden="true" />
                  <span className="x86-listing-line">{entry.line}</span>
                  <span className="x86-listing-address">{byteHex((entry.address >> 8) & 0xff)}{byteHex(entry.address & 0xff)}</span>
                  <span className="x86-listing-bytes">{entry.bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ") || "—"}</span>
                  <span className="x86-listing-text">{entry.text}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <div className="x86-panels">
        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Registers</strong><span>RV32I · {esp32AbiNames.length} ABI names</span></div>
          <div className="x86-register-grid">
            {registers.map((entry) => (
              <div className="x86-register" key={entry.label}><span>{entry.label}</span><strong>{entry.value}</strong></div>
            ))}
          </div>
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>GPIO</strong><span>GPIO_OUT latch · GPIO_IN switches</span></div>
          <div className="x86-port-block">
            <span className="x86-port-label">out = {(state.gpioOut & 0xff).toString(16).toUpperCase().padStart(2, "0")}h</span>
            <div className="x86-port-row">
              <span className="x86-port-name">out</span>
              <div className="x86-switch-row">
                {Array.from({ length: 8 }, (_, bit) => (
                  <span className={`x86-led ${(state.gpioOut >> bit) & 1 ? "is-on" : ""}`} key={bit} title={`GPIO${bit}`} />
                ))}
              </div>
            </div>
            <div className="x86-port-row">
              <span className="x86-port-name">in</span>
              <div className="x86-switch-row">
                {Array.from({ length: 8 }, (_, bit) => (
                  <button
                    className={`x86-switch ${(gpioInputs >> bit) & 1 ? "is-on" : ""}`}
                    key={bit}
                    onClick={() => toggleGpioBit(bit)}
                    type="button"
                  >
                    {bit}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Data memory</strong><span>64 KB · {memoryBaseValue.toString(16).toUpperCase().padStart(4, "0")}h page</span></div>
          <div className="x86-memory-controls">
            <button className="toolbar-icon-button" aria-label="Previous 128-byte page" onClick={() => showMemoryPage(-0x80)} type="button" title="Previous page"><Icon name="arrow-left" size={15} /></button>
            <input aria-label="Memory base address" className="x86-memory-input" onChange={(event) => setMemoryBase(event.target.value)} value={memoryBase} />
            <button className="toolbar-icon-button" aria-label="Next 128-byte page" onClick={() => showMemoryPage(0x80)} type="button" title="Next page"><Icon name="chevron-right" size={15} /></button>
          </div>
          {!machine && !run ? <p className="palette-help">Memory is read-only here. Run or step the program to see stored bytes.</p> : null}
          <div className="x86-memory">
            {Array.from({ length: 8 }, (_, row) => {
              const base = memoryBaseValue + row * 16;
              return (
                <div className="x86-memory-row" key={base}>
                  <span className="x86-memory-address">{(base & 0xffff).toString(16).toUpperCase().padStart(4, "0")}</span>
                  <span className="x86-memory-bytes">
                    {Array.from({ length: 16 }, (_, column) => {
                      const address = base + column;
                      return <span className="x86-memory-byte" key={column}>{byteHex(state.memory[address] ?? 0)}</span>;
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <section className="simulation-results x86-console-section">
        <div className="simulation-results-header">
          <div><span className="eyebrow">ESP32-C3 core</span><h2>UART output and diagnostics</h2></div>
          <div className="simulation-header-actions"><span className="status-pill">{statusLabel} · {run?.elapsedMs ?? 0} ms</span></div>
        </div>
        <div className="simulation-body">
          <div className="simulation-output-panel">
            <div className="simulation-panel-title"><strong>UART TX</strong><span>characters written to the transmit register</span></div>
            {run && run.console.length > 0 ? (
              <pre className="hdl-console">{run.console.map((character, index) => <span className="hdl-console-line" key={`${index}-${character}`}>{character}</span>)}</pre>
            ) : (
              <div className="simulation-empty">No UART output. Store a byte to the UART TX register to print a character.</div>
            )}
          </div>
          <div className="simulation-issues-panel">
            <div className="simulation-panel-title"><strong>Diagnostics</strong><span>{(assembly?.diagnostics.length ?? 0) + (runtimeError ? 1 : 0)} messages</span></div>
            {errors.length > 0 || runtimeError ? (
              <div className="issue-list">
                {errors.map((diagnostic, index) => (
                  <div className="issue-row issue-error" key={`asm-${diagnostic.line}-${index}`}>
                    <span className="issue-code">line {diagnostic.line}</span>
                    <span>{diagnostic.message}</span>
                  </div>
                ))}
                {runtimeError ? <div className="issue-row issue-error"><span className="issue-code">runtime</span><span>{runtimeError}</span></div> : null}
              </div>
            ) : (
              <div className="simulation-empty success-empty"><Icon name="check" size={17} /> The program assembled without errors.</div>
            )}
          </div>
        </div>
      </section>

      {waveform ? <WaveformViewer waveform={waveform} /> : null}

      <section className="hdl-help-panel">
        <div className="simulation-results-header"><div><span className="eyebrow">Reference</span><h2>Supported ESP32-C3 subset</h2></div></div>
        <div className="hdl-help-grid">
          {helpEntries.map((entry) => <div className="hdl-help-card" key={entry.title}><strong>{entry.title}</strong><p>{entry.detail}</p></div>)}
        </div>
        <p className="hdl-help-note">This is a functional RV32I integer subset running on a flat 64 KB memory model with a simplified ESP32-C3 GPIO/UART register map. There are no timers, interrupts, caches, floating point or Wi-Fi/Bluetooth peripherals. Register, memory, GPIO output and UART values reflect the executed program exactly.</p>
      </section>

      <section className="workspace-danger-zone circuit-danger-zone"><div><strong>Project actions</strong><p>Updated {formatDate(project.updatedAt)} · Changes are stored locally in this project.</p></div><button className="button button-danger" onClick={() => onDelete(project.id)} type="button"><Icon name="trash" size={16} /> Delete project</button></section>
    </div>
  );
}
