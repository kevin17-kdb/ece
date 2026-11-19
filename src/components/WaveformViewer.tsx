import { useState } from "react";
import { waveformToCsv, type DigitalWaveform, type WaveformSignal } from "../lib/waveform";
import { Icon } from "./Icon";

interface WaveformViewerProps {
  waveform: DigitalWaveform;
}

interface BusRun {
  start: number;
  end: number;
  value: string;
}

const rowHeight = 42;
const chartTop = 39;
const maxGridLines = 120;

function valueY(rowTop: number, value: string | undefined): number {
  if (value === "1") {
    return rowTop + 7;
  }

  if (value === "0") {
    return rowTop + 25;
  }

  return rowTop + 16;
}

function isUnknownValue(value: string): boolean {
  return /[xz]/i.test(value);
}

function busRuns(signal: WaveformSignal, sampleCount: number): BusRun[] {
  const runs: BusRun[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const value = signal.values[index] ?? "x";
    const current = runs[runs.length - 1];
    if (current && current.value === value) {
      current.end = index;
      continue;
    }

    runs.push({ start: index, end: index, value });
  }

  return runs;
}

export function WaveformViewer({ waveform }: WaveformViewerProps) {
  const [isExporting, setIsExporting] = useState(false);
  const sampleCount = waveform.samples.length;
  const times = waveform.samples.map((sample) => sample.timeNs);
  const longestLabel = waveform.signals.reduce((longest, signal) => Math.max(longest, signal.label.length), 6);
  const chartStartX = Math.min(330, Math.max(125, Math.round(longestLabel * 7.1) + 16));
  const firstDelta = times.length > 1 ? times[1] - times[0] : 0;
  const uniformTime = times.length > 2 && times.every((time, index) => index === 0 || time - times[index - 1] === firstDelta);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const plotWidth = Math.min(3600, Math.max(620, sampleCount * (uniformTime ? 44 : 22)));
  const chartWidth = chartStartX + plotWidth + 26;
  const chartHeight = Math.max(150, chartTop + waveform.signals.length * rowHeight + 18);
  const xFor = (index: number): number => {
    if (sampleCount <= 1) {
      return chartStartX;
    }

    if (uniformTime) {
      return chartStartX + (index * plotWidth) / (sampleCount - 1);
    }

    return chartStartX + (span <= 0 ? 0 : ((times[index] - times[0]) / span) * plotWidth);
  };

  const gridStride = Math.max(1, Math.ceil(sampleCount / maxGridLines));
  const gridIndexes = Array.from({ length: Math.ceil(sampleCount / gridStride) }, (_, index) => Math.min(sampleCount - 1, index * gridStride));

  function exportCsv() {
    setIsExporting(true);
    const blob = new Blob([waveformToCsv(waveform)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = waveform.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    setIsExporting(false);
  }

  return (
    <section className="waveform-panel">
      <div className="waveform-header">
        <div><span className="eyebrow">Instrument view</span><h2>{waveform.title}</h2><p>{waveform.description}</p></div>
        <div className="waveform-actions"><span className="status-pill">{sampleCount} samples · {waveform.timeUnitLabel}</span><button className="button button-secondary" disabled={isExporting || sampleCount === 0} onClick={exportCsv} type="button"><Icon name="save" size={15} /> {isExporting ? "Exporting" : "Export CSV"}</button></div>
      </div>
      <div className="waveform-scroll">
        <svg aria-label="Digital waveform" className="waveform-svg" role="img" viewBox={`0 0 ${chartWidth} ${chartHeight}`}>
          {gridIndexes.map((index) => {
            const x = xFor(index);
            return <g key={`grid-${index}`}><line className="wave-grid-line" x1={x} x2={x} y1="33" y2={chartHeight - 8} /><text className="wave-time-label" x={x} y={chartHeight - 1}>{times[index]}</text></g>;
          })}
          {waveform.signals.map((signal, signalIndex) => {
            const rowTop = chartTop + signalIndex * rowHeight;
            if (signal.kind === "bus") {
              const mid = rowTop + 18;
              return (
                <g key={signal.id}>
                  <text className="wave-signal-label" x="0" y={mid + 3}>{signal.label}</text>
                  <text className="wave-signal-width" x="0" y={mid + 15}>[{signal.width - 1}:0]</text>
                  {busRuns(signal, sampleCount).map((run) => {
                    const x0 = xFor(run.start);
                    const x1 = xFor(run.end);
                    const bevel = Math.min(7, Math.max(2, (x1 - x0) / 2));
                    const path = `M ${x0 - bevel} ${mid} L ${x0} ${mid - 11} L ${x1} ${mid - 11} L ${x1 + bevel} ${mid} L ${x1} ${mid + 11} L ${x0} ${mid + 11} Z`;
                    return (
                      <g key={`${run.start}-${run.end}`}>
                        <path className={`wave-bus-path ${isUnknownValue(run.value) ? "is-unknown" : ""}`} d={path}><title>{`${signal.label} = ${run.value}`}</title></path>
                        {x1 - x0 >= 36 ? <text className="wave-bus-value" x={(x0 + x1) / 2} y={mid + 3}>{run.value}</text> : null}
                      </g>
                    );
                  })}
                </g>
              );
            }

            const path = signal.values.map((value, index) => `${index === 0 ? "M" : "L"} ${xFor(index)} ${valueY(rowTop, value)}`).join(" ");
            return <g key={signal.id}><text className="wave-signal-label" x="0" y={rowTop + 20}>{signal.label}</text><path className="wave-signal-path" d={path} /></g>;
          })}
        </svg>
      </div>
      <div className="waveform-legend">
        <span><i className="legend-high" /> 1</span>
        <span><i className="legend-low" /> 0</span>
        <span><i className="legend-unknown" /> X / floating</span>
        {waveform.signals.some((signal) => signal.kind === "bus") ? <span><i className="legend-bus" /> bus value</span> : null}
        <span className="waveform-note">Values are captured from the deterministic simulation engine.</span>
      </div>
    </section>
  );
}
