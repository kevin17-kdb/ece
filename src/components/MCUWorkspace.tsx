import { useEffect, useMemo, useRef, useState } from "react";
import { assemble } from "../lib/mcu8051/assembler";
import { createMachine, createState, runMachine, stepMachine, type X8051Machine } from "../lib/mcu8051/simulator";
import {
  portAddresses,
  portNames,
  sfrAddress,
  type X8051Assembly,
  type X8051Diagnostic,
  type X8051RunResult,
  type X8051State,
  type X8051Step,
} from "../lib/mcu8051/types";
import { createMcuTemplate, getMcuSource, mcuStarterPrograms } from "../lib/mcuStarter";
import { captureX8051Waveform } from "../lib/waveform";
import { modeLabels, type LabProject, type McuDocument } from "../types/project";
import { CodeEditor, type EditorMarker } from "./CodeEditor";
import { Icon } from "./Icon";
import { WaveformViewer } from "./WaveformViewer";

interface MCUWorkspaceProps {
  project: LabProject;
  onBack: () => void;
  onDelete: (projectId: string) => void;
  onUpdateMcu: (projectId: string, mcu: McuDocument) => void;
}

const helpEntries = [
  { title: "Data movement", detail: "MOV, MOVX (A↔@DPTR/@Ri), MOVC (@A+DPTR/@A+PC), PUSH and POP." },
  { title: "Arithmetic", detail: "ADD, ADDC, SUBB on A; INC/DEC on A, Rn, @Ri, direct and DPTR; MUL AB, DIV AB." },
  { title: "Logic", detail: "ANL, ORL, XRL (A,target or direct,A / direct,#imm); CLR, CPL, SWAP and ROTATE on A." },
  { title: "Bit operations", detail: "CLR/CPL/SETB on C or a bit address; MOV C,bit and MOV bit,C." },
  { title: "Control flow", detail: "SJMP, LJMP, LCALL, RET/RETI, JZ/JNZ/JC/JNC, JB/JNB/JBC, CJNE, DJNZ, JMP @A+DPTR." },
  { title: "SFRs", detail: "A, B, PSW, SP, DPTR, P0–P3, SBUF and other SFRs by name. A write to SBUF prints a character." },
];

const flagRows: Array<{ label: string; mask: number; description: string }> = [
  { label: "CY", mask: 0x80, description: "Carry flag" },
  { label: "AC", mask: 0x40, description: "Auxiliary carry (half-carry)" },
  { label: "OV", mask: 0x04, description: "Overflow flag" },
  { label: "P", mask: 0x01, description: "Accumulator parity" },
];

function hex(value: number, width = 4): string {
  return (value & 0xffff).toString(16).toUpperCase().padStart(width, "0");
}

function byteHex(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export function MCUWorkspace({ project, onBack, onDelete, onUpdateMcu }: MCUWorkspaceProps) {
  const [source, setSource] = useState(() => getMcuSource(project.documents.mcu));
  const [machine, setMachine] = useState<X8051Machine | null>(null);
  const [steps, setSteps] = useState<X8051Step[]>([]);
  const [run, setRun] = useState<X8051RunResult | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [portInputs, setPortInputs] = useState<number[]>([0xff, 0xff, 0xff, 0xff]);
  const [iramPage, setIramPage] = useState(0);
  const [editAddress, setEditAddress] = useState("30");
  const [editValue, setEditValue] = useState("00");
  const [pendingStarter, setPendingStarter] = useState(mcuStarterPrograms[0].id);

  const machineRef = useRef<X8051Machine | null>(null);
  machineRef.current = machine;

  useEffect(() => {
    setSource(getMcuSource(project.documents.mcu));
    setMachine(null);
    setSteps([]);
    setRun(null);
    setRuntimeError(null);
    setPortInputs([0xff, 0xff, 0xff, 0xff]);
  }, [project.id]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      onUpdateMcu(project.id, createMcuTemplate(source));
    }, 400);
    return () => window.clearTimeout(handle);
  }, [onUpdateMcu, project.id, source]);

  const assembly: X8051Assembly | null = useMemo(() => {
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
    () => (assembly?.diagnostics ?? []).filter((diagnostic): diagnostic is X8051Diagnostic => diagnostic.severity === "error"),
    [assembly],
  );

  const markers: EditorMarker[] = useMemo(
    () => errors.map((diagnostic) => ({ line: diagnostic.line, severity: diagnostic.severity })),
    [errors],
  );

  const state: X8051State = machine?.state ?? run?.finalState ?? createState();
  const trace = run?.trace ?? steps;
  const waveform = useMemo(() => (trace.length > 0 ? captureX8051Waveform(trace, { maxSamples: 2000 }) : null), [trace]);

  function applyInputs(target: X8051State) {
    portAddresses.forEach((address, index) => {
      target.sfr[address - 0x80] = portInputs[index] & 0xff;
    });
  }

  function createSession(): X8051Machine {
    const created = createMachine(assembly ?? assemble(source));
    applyInputs(created.state);
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
    const program = mcuStarterPrograms.find((entry) => entry.id === id);
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

  function togglePortBit(portIndex: number, bit: number) {
    setPortInputs((current) => current.map((value, index) => (index === portIndex ? value ^ (1 << bit) : value)));
  }

  function writeIramByte() {
    if (!machine) {
      return;
    }

    const address = Number.parseInt(editAddress.replace(/[^0-9a-fA-F]/g, ""), 16);
    const value = Number.parseInt(editValue.replace(/[^0-9a-fA-F]/g, ""), 16);
    if (Number.isNaN(address) || Number.isNaN(value)) {
      return;
    }

    machine.state.iram[address & 0xff] = value & 0xff;
    setIramPage(address < 0x80 ? 0 : 1);
    setMachine({ ...machine });
  }

  const registers: Array<{ label: string; value: string }> = [
    { label: "PC", value: hex(state.pc) },
    { label: "A", value: byteHex(state.sfr[sfrAddress.acc - 0x80]) },
    { label: "B", value: byteHex(state.sfr[sfrAddress.b - 0x80]) },
    { label: "SP", value: byteHex(state.sfr[sfrAddress.sp - 0x80]) },
    { label: "DPTR", value: hex((state.sfr[sfrAddress.dph - 0x80] << 8) | state.sfr[sfrAddress.dpl - 0x80]) },
    { label: "PSW", value: byteHex(state.sfr[sfrAddress.psw - 0x80]) },
    ...Array.from({ length: 8 }, (_, index) => ({ label: `R${index}`, value: byteHex(state.iram[index]) })),
  ];

  const psw = state.sfr[sfrAddress.psw - 0x80];
  const statusLabel = runtimeError
    ? "Runtime error"
    : run
      ? run.haltReason === "halted" ? "Halted" : run.haltReason === "step-limit" ? "Step limit" : "Error"
      : machine ? "Paused" : "Not run";

  return (
    <div className="x86-workspace">
      <div className="circuit-topbar">
        <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> All projects</button>
        <div className="circuit-breadcrumb"><span>{modeLabels.mcu}</span><Icon name="chevron-right" size={14} /><span>8051 assembly</span></div>
      </div>

      <header className="circuit-header">
        <div>
          <span className="eyebrow">8051 microcontroller workspace</span>
          <h1>{project.name}</h1>
          <p>{project.description || "Write 8051 assembly, assemble it into machine code, and run or step the CPU while watching registers, flags, ports and internal RAM."}</p>
        </div>
        <div className="circuit-header-actions">
          <button className="button button-secondary" onClick={() => loadStarter(pendingStarter)} type="button"><Icon name="file" size={16} /> Load example</button>
          <button className="button button-secondary" onClick={doStep} type="button"><Icon name="play" size={16} /> Step</button>
          <button className="button button-primary" disabled={errors.length > 0} onClick={runProgram} type="button"><Icon name="play" size={16} /> Run</button>
        </div>
      </header>

      <div className="circuit-toolbar">
        <div className="circuit-toolbar-group"><span className="toolbar-label">Status</span><span className="toolbar-value">{statusLabel}</span></div>
        <div className="circuit-toolbar-group"><span className="toolbar-label">PC</span><span className="toolbar-value">{hex(state.pc)}h</span></div>
        <div className="circuit-toolbar-group"><span className="toolbar-label">Steps</span><span className="toolbar-value">{run?.steps ?? steps.length}</span></div>
        <div className="circuit-toolbar-spacer" />
        <button className="toolbar-icon-button" aria-label="Reset the machine" onClick={resetMachine} type="button" title="Reset the machine"><Icon name="trash" size={15} /></button>
        <div className={`simulation-health ${errors.length > 0 ? "has-errors" : "is-ready"}`}><span className="status-dot" /> {errors.length > 0 ? `${errors.length} error${errors.length === 1 ? "" : "s"}` : "Assembled"}</div>
      </div>

      <div className="circuit-layout hdl-layout x86-layout">
        <section className="schematic-panel hdl-editor-panel">
          <div className="schematic-panel-header">
            <div><strong>main.asm</strong><span>{source.split("\n").length} lines · 8051 assembly</span></div>
            <div className="hdl-editor-actions">
              <select
                aria-label="Example program"
                className="x86-memory-input"
                onChange={(event) => setPendingStarter(event.target.value)}
                value={pendingStarter}
              >
                {mcuStarterPrograms.map((program) => (
                  <option key={program.id} value={program.id}>{program.name}</option>
                ))}
              </select>
            </div>
          </div>
          <CodeEditor ariaLabel="8051 assembly source" markers={markers} onChange={commitSource} value={source} />
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
                  <span className="x86-listing-address">{hex(entry.address, 4)}</span>
                  <span className="x86-listing-bytes">{entry.bytes.map(byteHex).join(" ") || "—"}</span>
                  <span className="x86-listing-text">{entry.text}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <div className="x86-panels">
        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Registers</strong><span>8051 core</span></div>
          <div className="x86-register-grid">
            {registers.map((entry) => (
              <div className="x86-register" key={entry.label}><span>{entry.label}</span><strong>{entry.value}</strong></div>
            ))}
          </div>
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Flags</strong><span>PSW {byteHex(psw)}h</span></div>
          <div className="x86-flag-grid">
            {flagRows.map((entry) => (
              <div className={`x86-flag ${(psw & entry.mask) !== 0 ? "is-set" : ""}`} key={entry.label} title={entry.description}>
                <span>{entry.label}</span>
                <strong>{(psw & entry.mask) !== 0 ? "1" : "0"}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Ports</strong><span>latches · switches seed inputs</span></div>
          {portNames.map((name, index) => {
            const value = state.sfr[portAddresses[index] - 0x80];
            const input = portInputs[index] & 0xff;
            return (
              <div className="x86-port-block" key={name}>
                <span className="x86-port-label">{name} = {byteHex(value)}h</span>
                <div className="x86-port-row">
                  <span className="x86-port-name">out</span>
                  <div className="x86-switch-row">
                    {Array.from({ length: 8 }, (_, bit) => {
                      const bitIndex = 7 - bit;
                      return <span className={`x86-led ${(value >> bitIndex) & 1 ? "is-on" : ""}`} key={bitIndex} title={`P${index}.${bitIndex}`} />;
                    })}
                  </div>
                </div>
                <div className="x86-port-row">
                  <span className="x86-port-name">in</span>
                  <div className="x86-switch-row">
                    {Array.from({ length: 8 }, (_, bit) => {
                      const bitIndex = 7 - bit;
                      return (
                        <button
                          className={`x86-switch ${(input >> bitIndex) & 1 ? "is-on" : ""}`}
                          key={bitIndex}
                          onClick={() => togglePortBit(index, bitIndex)}
                          type="button"
                        >
                          {bitIndex}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Internal RAM</strong><span>00h–7Fh bank · 80h–FFh upper</span></div>
          <div className="x86-memory-controls">
            <button className="toolbar-icon-button" aria-label="Show lower 128 bytes of IRAM" onClick={() => setIramPage(0)} type="button" title="Lower 128 bytes">0–7F</button>
            <button className="toolbar-icon-button" aria-label="Show upper 128 bytes of IRAM" onClick={() => setIramPage(1)} type="button" title="Upper 128 bytes">80–FF</button>
          </div>
          <div className="x86-memory-edit">
            <span className="x86-port-label">Edit byte</span>
            <input aria-label="RAM edit address" className="x86-memory-input" onChange={(event) => setEditAddress(event.target.value)} value={editAddress} />
            <span className="x86-memory-equals">=</span>
            <input aria-label="RAM edit value" className="x86-memory-input" onChange={(event) => setEditValue(event.target.value)} value={editValue} />
            <button className="button button-secondary" disabled={!machine} onClick={writeIramByte} type="button">Write</button>
          </div>
          {!machine ? <p className="palette-help">Step into the program, then click a byte or type an address to edit internal RAM.</p> : null}
          <div className="x86-memory">
            {Array.from({ length: 8 }, (_, row) => {
              const base = iramPage * 0x80 + row * 16;
              return (
                <div className="x86-memory-row" key={base}>
                  <span className="x86-memory-address">{byteHex(base)}</span>
                  <span className="x86-memory-bytes">
                    {Array.from({ length: 16 }, (_, column) => {
                      const address = base + column;
                      return (
                        <button
                          className="x86-memory-byte"
                          key={column}
                          onClick={() => {
                            setEditAddress(byteHex(address));
                            setEditValue(byteHex(state.iram[address] ?? 0));
                          }}
                          type="button"
                        >
                          {byteHex(state.iram[address] ?? 0)}
                        </button>
                      );
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
          <div><span className="eyebrow">8051 core</span><h2>Serial output and diagnostics</h2></div>
          <div className="simulation-header-actions"><span className="status-pill">{statusLabel} · {run?.elapsedMs ?? 0} ms</span></div>
        </div>
        <div className="simulation-body">
          <div className="simulation-output-panel">
            <div className="simulation-panel-title"><strong>Serial (SBUF)</strong><span>characters written to SBUF</span></div>
            {run && run.console.length > 0 ? (
              <pre className="hdl-console">{run.console.map((character, index) => <span className="hdl-console-line" key={`${index}-${character}`}>{character}</span>)}</pre>
            ) : (
              <div className="simulation-empty">No serial output. Write a byte to SBUF to print a character.</div>
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
        <div className="simulation-results-header"><div><span className="eyebrow">Reference</span><h2>Supported 8051 subset</h2></div></div>
        <div className="hdl-help-grid">
          {helpEntries.map((entry) => <div className="hdl-help-card" key={entry.title}><strong>{entry.title}</strong><p>{entry.detail}</p></div>)}
        </div>
        <p className="hdl-help-note">This is a functional 8051 instruction subset (no timers, interrupts, external devices or bus arbitration). Port latches, internal RAM, SBUF output and the program counter reflect the executed program exactly.</p>
      </section>

      <section className="workspace-danger-zone circuit-danger-zone"><div><strong>Project actions</strong><p>Updated {formatDate(project.updatedAt)} · Changes are stored locally in this project.</p></div><button className="button button-danger" onClick={() => onDelete(project.id)} type="button"><Icon name="trash" size={16} /> Delete project</button></section>
    </div>
  );
}
