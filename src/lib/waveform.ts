import { simulateDigitalCircuit, type SimulationState } from "./digitalSimulation";
import type { VerilogSimulationResult } from "./verilog/simulator";
import { formatHex, valueToBinary } from "./verilog/values";
import type { X86Registers, X86StepTrace } from "./x86/types";
import type { X8051Step } from "./mcu8051/types";
import type { Esp32Step } from "./esp32/types";
import type { CircuitDocument, DigitalValue } from "../types/project";

export interface WaveformSample {
  timeNs: number;
  values: Record<string, string>;
}

interface WaveformSignalBase {
  id: string;
  label: string;
  values: string[];
}

export interface WaveformBitSignal extends WaveformSignalBase {
  kind: "bit";
  width: 1;
}

export interface WaveformBusSignal extends WaveformSignalBase {
  kind: "bus";
  width: number;
}

export type WaveformSignal = WaveformBitSignal | WaveformBusSignal;

export type WaveformKind = "combinational-sweep" | "trainer-trace" | "hdl-trace" | "x86-trace" | "mcu-trace" | "esp32-trace";

export interface X86WaveformOptions {
  registers?: string[];
  timeUnitLabel?: string;
  maxSamples?: number;
}

export interface DigitalWaveform {
  kind: WaveformKind;
  title: string;
  description: string;
  fileName: string;
  timeUnitLabel: string;
  stepNs: number;
  samples: WaveformSample[];
  signals: WaveformSignal[];
}

export interface WaveformOptions {
  maxSamples?: number;
  stepNs?: number;
  includeComponentValues?: boolean;
}

export interface VerilogWaveformOptions {
  signalPaths?: string[];
  timeUnitLabel?: string;
  maxSamples?: number;
}

function controlledInputIds(document: CircuitDocument): string[] {
  return document.components
    .filter((component) => component.type === "switch" || component.type === "clock")
    .map((component) => component.id);
}

function withInputValues(document: CircuitDocument, values: Record<string, DigitalValue>): CircuitDocument {
  return {
    ...document,
    components: document.components.map((component) => values[component.id] !== undefined
      ? { ...component, value: values[component.id] }
      : component),
  };
}

function currentInputValues(document: CircuitDocument): Record<string, DigitalValue> {
  return Object.fromEntries(
    document.components
      .filter((component) => component.type === "switch" || component.type === "clock")
      .map((component) => [component.id, component.value === "1" ? "1" : "0"]),
  );
}

export function captureX86Waveform(trace: X86StepTrace[], options: X86WaveformOptions = {}): DigitalWaveform {
  const maxSamples = Math.max(1, options.maxSamples ?? 2000);
  const samples = trace.slice(0, maxSamples);
  const registerList = options.registers ?? ["ip", "ax", "bx", "cx", "dx", "sp", "bp", "flags"];
  const signals: WaveformSignal[] = registerList.map((name) => {
    const values = samples.map((step) => `h${registerValue(step.registers, name).toString(16).toUpperCase().padStart(4, "0")}`);
    return {
      id: name,
      kind: "bus",
      label: name.toUpperCase(),
      width: 16,
      values,
    };
  });

  return {
    kind: "x86-trace",
    title: "CPU register trace",
    description: "Register values captured once per executed instruction.",
    fileName: "x86-register-trace.csv",
    timeUnitLabel: options.timeUnitLabel ?? "step",
    stepNs: 1,
    samples: samples.map((_, index) => ({ timeNs: index, values: {} })),
    signals,
  };
}

export interface X8051WaveformOptions {
  maxSamples?: number;
  timeUnitLabel?: string;
}

export function captureX8051Waveform(trace: X8051Step[], options: X8051WaveformOptions = {}): DigitalWaveform {
  const maxSamples = Math.max(1, options.maxSamples ?? 2000);
  const samples = trace.slice(0, maxSamples);
  const byte = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");

  const signals: WaveformSignal[] = [
    {
      id: "a",
      kind: "bus",
      label: "A",
      width: 8,
      values: samples.map((step) => `h${byte(step.a)}`),
    },
    {
      id: "p1",
      kind: "bus",
      label: "P1",
      width: 8,
      values: samples.map((step) => `h${byte(step.ports[1] ?? 0)}`),
    },
    {
      id: "p1.0",
      kind: "bit",
      label: "P1.0",
      width: 1,
      values: samples.map((step) => (((step.ports[1] ?? 0) & 1) ? "1" : "0")),
    },
  ];

  return {
    kind: "mcu-trace",
    title: "8051 peripheral trace",
    description: "Accumulator and Port 1 values captured once per executed instruction.",
    fileName: "mcu8051-trace.csv",
    timeUnitLabel: options.timeUnitLabel ?? "step",
    stepNs: 1,
    samples: samples.map((_, index) => ({ timeNs: index, values: {} })),
    signals,
  };
}

export interface Esp32WaveformOptions {
  maxSamples?: number;
  timeUnitLabel?: string;
}

export function captureEsp32Waveform(trace: Esp32Step[], options: Esp32WaveformOptions = {}): DigitalWaveform {
  const maxSamples = Math.max(1, options.maxSamples ?? 2000);
  const samples = trace.slice(0, maxSamples);
  const byte = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");

  const signals: WaveformSignal[] = [
    {
      id: "gpio",
      kind: "bus",
      label: "GPIO0-7",
      width: 8,
      values: samples.map((step) => `h${byte(step.gpio)}`),
    },
    ...Array.from({ length: 8 }, (_, bit) => ({
      id: `gpio.${bit}`,
      kind: "bit" as const,
      label: `GPIO${bit}`,
      width: 1 as const,
      values: samples.map((step) => ((step.gpio >> bit) & 1 ? "1" : "0")),
    })),
  ];

  return {
    kind: "esp32-trace",
    title: "ESP32-C3 GPIO trace",
    description: "GPIO output bits captured once per executed RISC-V instruction.",
    fileName: "esp32-gpio-trace.csv",
    timeUnitLabel: options.timeUnitLabel ?? "step",
    stepNs: 1,
    samples: samples.map((_, index) => ({ timeNs: index, values: {} })),
    signals,
  };
}

function registerValue(registers: X86Registers, name: string): number {
  if (name in registers) {
    return registers[name as keyof X86Registers] & 0xffff;
  }

  return 0;
}

export function formatBusValue(value: string, width: number): string {
  if (width <= 1) {
    return valueToBinary(value).slice(0, 1) || "x";
  }

  return `${width}'h${formatHex(value)}`;
}

export function captureDigitalWaveform(document: CircuitDocument, options: WaveformOptions = {}): DigitalWaveform {
  const maxSamples = Math.max(1, options.maxSamples ?? 32);
  const stepNs = Math.max(1, options.stepNs ?? 10);
  const controlledIds = controlledInputIds(document);
  const clockIds = document.components.filter((component) => component.type === "clock").map((component) => component.id);
  const hasClock = clockIds.length > 0;
  let state: SimulationState | undefined;
  const samples: WaveformSample[] = [];
  const sweepCount = controlledIds.length > 0 && controlledIds.length <= 8 ? 2 ** controlledIds.length : maxSamples;
  const totalSamples = hasClock ? maxSamples : Math.min(sweepCount, maxSamples);

  for (let index = 0; index < totalSamples; index += 1) {
    const values = currentInputValues(document);

    if (hasClock) {
      for (const clockId of clockIds) {
        values[clockId] = index % 2 === 0 ? "0" : "1";
      }
    } else {
      for (let bit = 0; bit < controlledIds.length; bit += 1) {
        const id = controlledIds[bit];
        if (id) {
          values[id] = (index >> (controlledIds.length - bit - 1)) & 1 ? "1" : "0";
        }
      }
    }

    const result = simulateDigitalCircuit(withInputValues(document, values), { initialState: state });
    state = result.state;
    samples.push({
      timeNs: index * stepNs,
      values: { ...result.nodeValues, ...result.componentValues },
    });
  }

  const channels = [
    ...document.nets.map((net) => ({ id: net.nodeIds[0] ?? net.id, label: `net ${net.name}` })),
    ...(options.includeComponentValues ? document.components.map((component) => ({ id: component.id, label: component.label })) : []),
  ];
  const fallback = channels.length > 0
    ? channels
    : document.components.map((component) => ({ id: component.id, label: component.label }));

  const signals: WaveformSignal[] = fallback.map((channel) => ({
    id: channel.id,
    kind: "bit",
    label: channel.label,
    width: 1,
    values: samples.map((sample) => sample.values[channel.id] ?? "x"),
  }));

  return {
    kind: hasClock ? "trainer-trace" : "combinational-sweep",
    title: "Logic analyzer",
    description: hasClock
      ? "Clocked trainer trace from simulated component states."
      : "Combinational sweep across the current controllable inputs.",
    fileName: "digital-waveform.csv",
    timeUnitLabel: "ns",
    stepNs,
    samples,
    signals,
  };
}

export function captureVerilogWaveform(result: VerilogSimulationResult, options: VerilogWaveformOptions = {}): DigitalWaveform {
  const selected = options.signalPaths && options.signalPaths.length > 0
    ? result.signals.filter((signal) => options.signalPaths?.includes(signal.path))
    : result.signals;
  const captured = selected.length > 0 ? selected : result.signals;
  const maxSamples = Math.max(1, options.maxSamples ?? 2000);
  const timeUnitLabel = options.timeUnitLabel ?? result.timeUnitLabel;

  const valuesFor = (sample: { values: Record<string, string> }, signal: { path: string; width: number }): string => {
    const value = sample.values[signal.path];
    if (value === undefined) {
      return signal.width <= 1 ? "x" : formatBusValue("x".repeat(signal.width * 2), signal.width);
    }

    return signal.width <= 1 ? formatBusValue(value, 1) : formatBusValue(value, signal.width);
  };

  const samples = result.samples.slice(0, maxSamples);
  const signals: WaveformSignal[] = captured.map((signal) => {
    const values = samples.map((sample) => valuesFor(sample, signal));
    return signal.width <= 1
      ? { id: signal.path, kind: "bit", label: signal.label, width: 1, values }
      : { id: signal.path, kind: "bus", label: signal.label, width: signal.width, values };
  });

  return {
    kind: "hdl-trace",
    title: `Waveform · ${result.topModule || "top"}`,
    description: `Event-driven trace captured from the simulated design, in ${timeUnitLabel}.`,
    fileName: "hdl-waveform.csv",
    timeUnitLabel,
    stepNs: result.timeUnitNs,
    samples: samples.map((sample) => ({ timeNs: sample.timeNs, values: sample.values })),
    signals,
  };
}

export function waveformToCsv(waveform: DigitalWaveform): string {
  const header = ["time_ns", ...waveform.signals.map((signal) => signal.label)].join(",");
  const rows = waveform.samples.map((sample, sampleIndex) => [
    sample.timeNs,
    ...waveform.signals.map((signal) => signal.values[sampleIndex] ?? "x"),
  ].join(","));
  return [header, ...rows].join("\n");
}
