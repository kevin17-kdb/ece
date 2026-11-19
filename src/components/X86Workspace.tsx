import { useEffect, useMemo, useRef, useState } from "react";
import { assemble, X86AsmError } from "../lib/x86/assembler";
import { createContext, type X86Context, type X86Device } from "../lib/x86/cpu";
import { createMemory, simulateX86, stepX86 } from "../lib/x86/simulator";
import { evaluateWatch } from "../lib/x86/watch";
import {
  flagBits,
  flagLabels,
  numberToFlags,
  type X86Assembly,
  type X86Diagnostic,
  type X86Flags,
  type X86ListingEntry,
  type X86Registers,
  type X86RunResult,
  type X86StepTrace,
} from "../lib/x86/types";
import { captureX86Waveform } from "../lib/waveform";
import { modeLabels, type LabProject, type X86Document } from "../types/project";
import { createX86RegisterStarter, createX86Template, createX86TrainerStarter, trainerPorts } from "../lib/x86Starter";
import { CodeEditor, type EditorMarker } from "./CodeEditor";
import { Icon } from "./Icon";
import { WaveformViewer } from "./WaveformViewer";

interface X86WorkspaceProps {
  project: LabProject;
  onBack: () => void;
  onDelete: (projectId: string) => void;
  onUpdateX86: (projectId: string, x86: X86Document) => void;
}

interface StepSession {
  context: X86Context;
  listing: X86ListingEntry[];
}

const byteRegisters: Array<{ label: string; register: keyof X86Registers; high?: boolean }> = [
  { label: "AL", register: "ax" },
  { label: "AH", register: "ax", high: true },
  { label: "BL", register: "bx" },
  { label: "BH", register: "bx", high: true },
  { label: "CL", register: "cx" },
  { label: "CH", register: "cx", high: true },
  { label: "DL", register: "dx" },
  { label: "DH", register: "dx", high: true },
];

const wordRegisters: Array<{ label: string; register: keyof X86Registers }> = [
  { label: "AX", register: "ax" },
  { label: "BX", register: "bx" },
  { label: "CX", register: "cx" },
  { label: "DX", register: "dx" },
  { label: "SI", register: "si" },
  { label: "DI", register: "di" },
  { label: "BP", register: "bp" },
  { label: "SP", register: "sp" },
];

const segmentRegisters: Array<{ label: string; register: keyof X86Registers }> = [
  { label: "CS", register: "cs" },
  { label: "DS", register: "ds" },
  { label: "SS", register: "ss" },
  { label: "ES", register: "es" },
  { label: "IP", register: "ip" },
];

const helpEntries = [
  { title: "Directives", detail: "org, equ, db, dw, and label: definitions" },
  { title: "Operands", detail: "registers, byte/word memory, [bx+si+disp], segment overrides es:/ds:" },
  { title: "Data", detail: "db/dw with numbers, hex literals, and 'c' character literals" },
  { title: "Control flow", detail: "jmp, call, ret, jcc (SHORT/NEAR), loop, jcxz" },
  { title: "Stack", detail: "push, pop, and call/ret using SS:SP; default SS = 1000h, SP = FFFEh" },
  { title: "I/O and DOS", detail: "in/out with a port or DX; INT 21h AH=02/AH=09; INT 20h terminates" },
];

function emptyDocument(): X86Document {
  return { source: "", machineCode: [] };
}

function getDocument(project: LabProject): X86Document {
  return project.documents.x86 ?? emptyDocument();
}

function hex(value: number, width = 4): string {
  return (value & 0xffff).toString(16).toUpperCase().padStart(width, "0");
}

function byteHex(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function bitMask(register: number, high: boolean | undefined): number {
  const base = register & 0xffff;
  return high ? (base >> 8) & 0xff : base & 0xff;
}

export function X86Workspace({ project, onBack, onDelete, onUpdateX86 }: X86WorkspaceProps) {
  const [source, setSource] = useState<string>(() => getDocument(project).source);
  const [session, setSession] = useState<StepSession | null>(null);
  const [steps, setSteps] = useState<X86StepTrace[]>([]);
  const [run, setRun] = useState<X86RunResult | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [switchValues, setSwitchValues] = useState<Record<number, number>>({});
  const [outputValues, setOutputValues] = useState<Record<number, number>>({});
  const [memoryStart, setMemoryStart] = useState(0x100);
  const [breakpoints, setBreakpoints] = useState<Set<number>>(() => new Set());
  const [watches, setWatches] = useState<string[]>([]);
  const [watchInput, setWatchInput] = useState("");
  const [editAddress, setEditAddress] = useState("0100");
  const [editValue, setEditValue] = useState("00");

  const switchRef = useRef(switchValues);
  switchRef.current = switchValues;

  const device = useMemo<X86Device>(() => ({
    read: (port) => switchRef.current[port] ?? 0,
    write: (port, value) => {
      setOutputValues((current) => ({ ...current, [port]: value & 0xffff }));
    },
  }), []);

  useEffect(() => {
    setSource(getDocument(project).source);
    setSession(null);
    setSteps([]);
    setRun(null);
    setRuntimeError(null);
    setSwitchValues({});
    setOutputValues({});
  }, [project.id]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      onUpdateX86(project.id, { source, machineCode: [] });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [onUpdateX86, project.id, source]);

  const assembly: X86Assembly | null = useMemo(() => {
    try {
      return assemble(source);
    } catch (error) {
      if (error instanceof X86AsmError) {
        return {
          bytes: [],
          origin: 0x100,
          entryPoint: 0x100,
          codeEnd: 0x100,
          listing: [],
          symbols: [],
          segments: [],
          diagnostics: [{ severity: "error", message: error.reason, line: error.line }],
        };
      }

      throw error;
    }
  }, [source]);

  const errors = useMemo(
    () => (assembly?.diagnostics ?? []).filter((diagnostic): diagnostic is X86Diagnostic => diagnostic.severity === "error"),
    [assembly],
  );

  const markers: EditorMarker[] = useMemo(
    () => errors.map((diagnostic) => ({ line: diagnostic.line, severity: diagnostic.severity })),
    [errors],
  );

  const registers: X86Registers = session?.context.registers ?? run?.finalRegisters ?? createContext(createMemory(), device, { entryPoint: 0 }).registers;
  const flags: X86Flags = run?.finalFlags ?? numberToFlags(registers.flags);

  const programMemory = useMemo(() => {
    const memory = new Uint8Array(0x10000);
    for (let index = 0; index < (assembly?.bytes.length ?? 0) && index < memory.length; index += 1) {
      memory[index] = assembly?.bytes[index] ?? 0;
    }

    return memory;
  }, [assembly]);

  const memory = session?.context.memory ?? programMemory;
  const consoleLines = run?.console ?? session?.context.output ?? [];
  const trace = run?.trace ?? steps;
  const waveform = useMemo(() => (trace.length > 0 ? captureX86Waveform(trace, { maxSamples: 2000 }) : null), [trace]);

  useEffect(() => {
    setOutputValues((current) => {
      if (run) {
        return { ...current, ...run.portValues };
      }

      return current;
    });
  }, [run]);

  function commitSource(next: string) {
    setSource(next);
    setSession(null);
    setSteps([]);
    setRuntimeError(null);
    setBreakpoints(new Set());
  }

  function toggleBreakpoint(address: number) {
    setBreakpoints((current) => {
      const next = new Set(current);
      if (next.has(address)) {
        next.delete(address);
      } else {
        next.add(address);
      }

      return next;
    });
  }

  function addWatch() {
    const expression = watchInput.trim();
    if (expression.length === 0) {
      return;
    }

    setWatches((current) => (current.includes(expression) ? current : [...current, expression]));
    setWatchInput("");
  }

  function removeWatch(expression: string) {
    setWatches((current) => current.filter((item) => item !== expression));
  }

  function writeMemoryByte() {
    if (!session) {
      return;
    }

    const address = Number.parseInt(editAddress.replace(/[^0-9a-fA-F]/g, ""), 16);
    const value = Number.parseInt(editValue.replace(/[^0-9a-fA-F]/g, ""), 16);
    if (Number.isNaN(address) || Number.isNaN(value)) {
      return;
    }

    session.context.memory[address & 0xfffff] = value & 0xff;
    setSession({ ...session, context: session.context });
    setMemoryStart(Math.min(0xff00, Math.max(0, address - (address % 16))));
  }

  function resetMachine() {
    setSession(null);
    setSteps([]);
    setRun(null);
    setRuntimeError(null);
    setOutputValues({});
  }

  function loadStarter(kind: "template" | "register" | "trainer") {
    if (source.trim().length > 0 && !window.confirm("Replace the current source with an example program?")) {
      return;
    }

    const next = kind === "register" ? createX86RegisterStarter() : kind === "trainer" ? createX86TrainerStarter() : createX86Template();
    commitSource(next.source);
    setRun(null);
  }

  function doStep() {
    if (errors.length > 0) {
      return;
    }

    let active = session;
    if (!active) {
      const listing = assembly?.listing ?? [];
      active = { context: createContext(buildMemory(assembly), device, { entryPoint: assembly?.entryPoint ?? 0x100 }), listing };
    }

    try {
      const step = stepX86(active.context, active.listing);
      setSession({ ...active });
      setSteps((current) => [...current, step]);
      setRuntimeError(null);
    } catch (error) {
      setSession({ ...active });
      setRuntimeError(error instanceof Error ? error.message : String(error));
    }
  }

  function runProgram() {
    if (errors.length > 0) {
      return;
    }

    if (breakpoints.size === 0) {
      setOutputValues({});
      const result = simulateX86({ source, device, maxSteps: 200000 });
      setRun(result);
      setSession(null);
      setSteps([]);
      setRuntimeError(result.error?.message ?? null);
      return;
    }

    const hasSession = session !== null;
    const active: StepSession =
      session ?? {
        context: createContext(buildMemory(assembly), device, { entryPoint: assembly?.entryPoint ?? 0x100 }),
        listing: assembly?.listing ?? [],
      };
    const created: X86StepTrace[] = [];
    let failure: string | null = null;
    const maxSteps = 200000;

    for (let executed = 0; executed < maxSteps; executed += 1) {
      const ctx = active.context;
      if (ctx.halted || ctx.terminated) {
        break;
      }

      if (executed > 0 && breakpoints.has(ctx.registers.ip)) {
        break;
      }

      try {
        created.push(stepX86(ctx, active.listing));
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
    }

    setRun(null);
    setSession({ ...active });
    setSteps((current) => (hasSession ? [...current, ...created] : created));
    setRuntimeError(failure);
  }

  const statusLabel = runtimeError
    ? "Runtime error"
    : run
      ? run.haltReason === "terminated" ? "Terminated" : run.haltReason === "halted" ? "Halted" : run.haltReason === "step-limit" ? "Step limit" : "Error"
      : session ? "Paused" : "Not run";

  return (
    <div className="x86-workspace">
      <div className="circuit-topbar">
        <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> All projects</button>
        <div className="circuit-breadcrumb"><span>{modeLabels.x86}</span><Icon name="chevron-right" size={14} /><span>Assembly</span></div>
      </div>

      <header className="circuit-header">
        <div>
          <span className="eyebrow">8086 assembly workspace</span>
          <h1>{project.name}</h1>
          <p>{project.description || "Write 8086 assembly, assemble it, and step the CPU while watching registers, flags, memory, and ports."}</p>
        </div>
        <div className="circuit-header-actions">
          <button className="button button-secondary" onClick={() => loadStarter("register")} type="button"><Icon name="cpu" size={16} /> Register demo</button>
          <button className="button button-secondary" onClick={() => loadStarter("trainer")} type="button"><Icon name="grid" size={16} /> Trainer demo</button>
          <button className="button button-secondary" onClick={doStep} type="button"><Icon name="play" size={16} /> Step</button>
          <button className="button button-primary" disabled={errors.length > 0} onClick={runProgram} type="button"><Icon name="play" size={16} /> Run</button>
        </div>
      </header>

      <div className="circuit-toolbar">
        <div className="circuit-toolbar-group"><span className="toolbar-label">Status</span><span className="toolbar-value">{statusLabel}</span></div>
        <div className="circuit-toolbar-group"><span className="toolbar-label">IP</span><span className="toolbar-value">{hex(registers.ip)}h</span></div>
        <div className="circuit-toolbar-group"><span className="toolbar-label">Steps</span><span className="toolbar-value">{run?.steps ?? steps.length}</span></div>
        <div className="circuit-toolbar-spacer" />
        <button className="toolbar-icon-button" aria-label="Reset the machine" onClick={resetMachine} type="button" title="Reset the machine"><Icon name="trash" size={15} /></button>
        <div className={`simulation-health ${errors.length > 0 ? "has-errors" : "is-ready"}`}><span className="status-dot" /> {errors.length > 0 ? `${errors.length} error${errors.length === 1 ? "" : "s"}` : "Assembled"}</div>
      </div>

      <div className="circuit-layout hdl-layout x86-layout">
        <section className="schematic-panel hdl-editor-panel">
          <div className="schematic-panel-header">
            <div><strong>program.asm</strong><span>{source.split("\n").length} lines · 8086 assembly</span></div>
            <div className="hdl-editor-actions">
              <button className="button button-secondary" onClick={() => loadStarter("template")} type="button"><Icon name="file" size={14} /> New</button>
            </div>
          </div>
          <CodeEditor ariaLabel="8086 assembly source" markers={markers} onChange={commitSource} value={source} />
        </section>

        <section className="schematic-panel x86-listing-panel">
          <div className="schematic-panel-header">
            <div><strong>Listing</strong><span>{assembly?.listing?.length ?? 0} instructions · {breakpoints.size} breakpoint{breakpoints.size === 1 ? "" : "s"} · click a row to toggle</span></div>
          </div>
          <div className="x86-listing">
            {(assembly?.listing?.length ?? 0) === 0 ? (
              <div className="simulation-empty">Assemble a program to see the machine code.</div>
            ) : (
              assembly?.listing.map((entry) => (
                <div
                  className={`x86-listing-row ${entry.address === registers.ip ? "is-current" : ""} ${breakpoints.has(entry.address) ? "has-breakpoint" : ""}`}
                  key={`${entry.address}-${entry.line}`}
                  onClick={() => toggleBreakpoint(entry.address)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleBreakpoint(entry.address);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title="Toggle breakpoint"
                >
                  <span className={`x86-breakpoint ${breakpoints.has(entry.address) ? "is-on" : ""}`} aria-hidden="true" />
                  <span className="x86-listing-line">{entry.line}</span>
                  <span className="x86-listing-address">{hex(entry.address)}</span>
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
          <div className="simulation-panel-title"><strong>Registers</strong><span>16-bit view</span></div>
          <div className="x86-register-grid">
            {wordRegisters.map((entry) => (
              <div className="x86-register" key={entry.label}><span>{entry.label}</span><strong>{hex(registers[entry.register])}</strong></div>
            ))}
            {segmentRegisters.map((entry) => (
              <div className="x86-register is-segment" key={entry.label}><span>{entry.label}</span><strong>{hex(registers[entry.register])}</strong></div>
            ))}
          </div>
          <div className="simulation-panel-title x86-subheading"><strong>Byte registers</strong><span>low / high</span></div>
          <div className="x86-register-grid x86-register-grid-bytes">
            {byteRegisters.map((entry) => (
              <div className="x86-register" key={entry.label}><span>{entry.label}</span><strong>{byteHex(bitMask(registers[entry.register], entry.high))}</strong></div>
            ))}
          </div>
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Flags</strong><span>{hex(registers.flags)}h</span></div>
          <div className="x86-flag-grid">
            {flagLabels.map((entry) => (
              <div className={`x86-flag ${flags[entry.key] ? "is-set" : ""}`} key={entry.key} title={entry.description}>
                <span>{entry.name}</span>
                <strong>{flags[entry.key] ? "1" : "0"}</strong>
              </div>
            ))}
          </div>
          <div className="x86-bitfield">
            {flagBits.slice().reverse().map(([key, bit]) => (
              <span className={`x86-bit ${flags[key] ? "is-set" : ""}`} key={key} title={`${key.toUpperCase()} bit ${Math.log2(bit)}`}>
                {flags[key] ? 1 : 0}
              </span>
            ))}
          </div>
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Watches</strong><span>{watches.length} watch{watches.length === 1 ? "" : "es"}</span></div>
          <div className="x86-memory-edit">
            <input
              aria-label="Watch expression"
              className="x86-watch-input"
              onChange={(event) => setWatchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addWatch();
                }
              }}
              placeholder="ax, cf, [bx+si+2], ds:100h"
              value={watchInput}
            />
            <button className="button button-secondary" onClick={addWatch} type="button"><Icon name="plus" size={14} /> Add</button>
          </div>
          {watches.length === 0 ? (
            <p className="palette-help">Watch registers, flags or memory (e.g. ax, cf, [bx], ds:100h).</p>
          ) : (
            <div className="x86-watch-list">
              {watches.map((expression) => {
                const evaluation = evaluateWatch(expression, registers, memory);
                return (
                  <div className="x86-watch-row" key={expression} title={evaluation.error ?? ""}>
                    <span className="x86-watch-expression">{expression}</span>
                    <strong className={`digital-value ${evaluation.error ? "digital-x" : ""}`}>{evaluation.text}</strong>
                    <button className="toolbar-icon-button" aria-label={`Remove watch ${expression}`} onClick={() => removeWatch(expression)} title="Remove watch" type="button"><Icon name="x" size={13} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Memory</strong><span>DS:0000 style dump</span></div>
          <div className="x86-memory-controls">
            <button className="toolbar-icon-button" aria-label="Previous memory page" onClick={() => setMemoryStart((value) => Math.max(0, value - 0x100))} type="button" title="Previous page">−</button>
            <input
              aria-label="Memory start address"
              className="x86-memory-input"
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value.replace(/[^0-9a-fA-F]/g, ""), 16);
                if (!Number.isNaN(parsed)) {
                  setMemoryStart(Math.min(0xff00, Math.max(0, parsed)));
                }
              }}
              value={hex(memoryStart)}
            />
            <button className="toolbar-icon-button" aria-label="Next memory page" onClick={() => setMemoryStart((value) => Math.min(0xff00, value + 0x100))} type="button" title="Next page">+</button>
          </div>
          <div className="x86-memory-edit">
            <span className="x86-port-label">Edit byte</span>
            <input aria-label="Memory edit address" className="x86-memory-input" onChange={(event) => setEditAddress(event.target.value)} value={editAddress} />
            <span className="x86-memory-equals">=</span>
            <input aria-label="Memory edit value" className="x86-memory-input" onChange={(event) => setEditValue(event.target.value)} value={editValue} />
            <button className="button button-secondary" disabled={!session} onClick={writeMemoryByte} type="button">Write</button>
          </div>
          {!session ? <p className="palette-help">Step into the program, then click a byte or type an address to edit memory.</p> : null}
          <div className="x86-memory">
            {Array.from({ length: 8 }, (_, row) => {
              const base = memoryStart + row * 16;
              return (
                <div className="x86-memory-row" key={base}>
                  <span className="x86-memory-address">{hex(base)}</span>
                  <span className="x86-memory-bytes">
                    {Array.from({ length: 16 }, (_, column) => {
                      const address = base + column;
                      return (
                        <button
                          className="x86-memory-byte"
                          key={column}
                          onClick={() => {
                            setEditAddress(hex(address));
                            setEditValue(byteHex(memory[address] ?? 0));
                          }}
                          type="button"
                        >
                          {byteHex(memory[address] ?? 0)}
                        </button>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="x86-panel">
          <div className="simulation-panel-title"><strong>Trainer ports</strong><span>switches in · LEDs out</span></div>
          <div className="x86-port-block">
            <span className="x86-port-label">Switches · {hex(trainerPorts.switchLow, 2)}h / {hex(trainerPorts.switchHigh, 2)}h</span>
            {[trainerPorts.switchLow, trainerPorts.switchHigh].map((port) => (
              <div className="x86-port-row" key={port}>
                <span className="x86-port-name">{hex(port, 2)}</span>
                <div className="x86-switch-row">
                  {Array.from({ length: 8 }, (_, bit) => {
                    const index = 7 - bit;
                    const value = switchValues[port] ?? 0;
                    const isSet = (value >> index) & 1;
                    return (
                      <button
                        className={`x86-switch ${isSet ? "is-on" : ""}`}
                        key={index}
                        onClick={() => setSwitchValues((current) => ({ ...current, [port]: (current[port] ?? 0) ^ (1 << index) }))}
                        type="button"
                      >
                        {index}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="x86-port-block">
            <span className="x86-port-label">LEDs · {hex(trainerPorts.ledLow, 2)}h / {hex(trainerPorts.ledHigh, 2)}h</span>
            {Object.entries(outputValues).filter(([port]) => Number(port) >= 0x20 && Number(port) <= 0x2f).length === 0 ? (
              <p className="palette-help">Run a program that writes to ports 20h–2fh to light the LEDs.</p>
            ) : (
              Object.entries(outputValues)
                .filter(([port]) => Number(port) >= 0x20 && Number(port) <= 0x2f)
                .map(([port, value]) => (
                  <div className="x86-port-row" key={port}>
                    <span className="x86-port-name">{hex(Number(port), 2)}</span>
                    <div className="x86-led-row">
                      {Array.from({ length: 8 }, (_, bit) => {
                        const index = 7 - bit;
                        const isSet = (value >> index) & 1;
                        return <span className={`x86-led ${isSet ? "is-on" : ""}`} key={index} title={`bit ${index}`} />;
                      })}
                    </div>
                    <span className="x86-port-value">{hex(value, 2)}</span>
                  </div>
                ))
            )}
          </div>
        </section>
      </div>

      <section className="simulation-results x86-console-section">
        <div className="simulation-results-header">
          <div><span className="eyebrow">8086 core</span><h2>Console and diagnostics</h2></div>
          <div className="simulation-header-actions"><span className="status-pill">{statusLabel} · {run?.elapsedMs ?? 0} ms</span></div>
        </div>
        <div className="simulation-body">
          <div className="simulation-output-panel">
            <div className="simulation-panel-title"><strong>DOS console</strong><span>INT 21h output</span></div>
            {consoleLines.length > 0 ? (
              <pre className="hdl-console">{consoleLines.map((line, index) => <span className="hdl-console-line" key={`${index}-${line}`}>{line}</span>)}</pre>
            ) : (
              <div className="simulation-empty">No console output. Use INT 21h AH=09 or AH=02 to print text.</div>
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
        <div className="simulation-results-header"><div><span className="eyebrow">Reference</span><h2>Supported 8086 subset</h2></div></div>
        <div className="hdl-help-grid">
          {helpEntries.map((entry) => <div className="hdl-help-card" key={entry.title}><strong>{entry.title}</strong><p>{entry.detail}</p></div>)}
        </div>
        <p className="hdl-help-note">Emulated BIOS/DOS interrupts: INT 21h AH=02 and AH=09, INT 20h. Any other vector or AH raises an explicit error.</p>
      </section>

      <section className="workspace-danger-zone circuit-danger-zone"><div><strong>Project actions</strong><p>Updated {formatDate(project.updatedAt)} · Changes are stored locally in this project.</p></div><button className="button button-danger" onClick={() => onDelete(project.id)} type="button"><Icon name="trash" size={16} /> Delete project</button></section>
    </div>
  );
}

function buildMemory(assembly: X86Assembly | null): Uint8Array {
  const memory = createMemory();
  for (let index = 0; index < (assembly?.bytes.length ?? 0); index += 1) {
    memory[index] = assembly?.bytes[index] ?? 0;
  }

  return memory;
}
