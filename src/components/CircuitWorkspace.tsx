import { useEffect, useRef, useState } from "react";
import { createCircuitComponent, getComponentDefinition, pinNodeId, unitStateKey, componentDefinitions } from "../lib/circuitCatalog";
import { connectPins, createExampleCircuit, createTrainerCounterExample, removeComponent, rotateComponent, setComponentParameter, setComponentValue } from "../lib/circuitOperations";
import { pushPast, redoStep, undoStep } from "../lib/editHistory";
import { simulateDigitalCircuit, formatDigitalValue, type SimulationState } from "../lib/digitalSimulation";
import { buildNetlist, toSpiceNetlist } from "../lib/netlist";
import { buildTruthTable, type TruthTableResult } from "../lib/truthTable";
import { captureDigitalWaveform, type DigitalWaveform } from "../lib/waveform";
import type { CircuitComponent, CircuitDocument, LabProject } from "../types/project";
import { Icon } from "./Icon";
import { WaveformViewer } from "./WaveformViewer";

interface CircuitWorkspaceProps {
  project: LabProject;
  onBack: () => void;
  onDelete: (projectId: string) => void;
  onUpdateCircuit: (projectId: string, circuit: CircuitDocument) => void;
}

interface WireEndpoint {
  componentId: string;
  pinId: string;
}

interface DragState {
  pointerStart: { x: number; y: number };
  startPositions: Record<string, { x: number; y: number }>;
}

let idCounter = 0;

function uniqueId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

const canvasWidth = 1400;
const canvasHeight = 900;

const sevenSegmentPaths: Record<string, string> = {
  a: "M 54 44 H 96",
  b: "M 102 50 V 100",
  c: "M 102 114 V 164",
  d: "M 54 172 H 96",
  e: "M 46 114 V 164",
  f: "M 46 50 V 100",
  g: "M 54 108 H 96",
};

const paletteGroups = Array.from(
  Object.values(componentDefinitions).reduce((groups, definition) => {
    const existing = groups.get(definition.category) ?? [];
    existing.push(definition);
    groups.set(definition.category, existing);
    return groups;
  }, new Map<string, typeof componentDefinitions[string][]>()),
);

function emptyCircuit(): CircuitDocument {
  return { components: [], nets: [], gridSize: 20 };
}

function getCircuit(project: LabProject): CircuitDocument {
  return project.documents.circuit ?? emptyCircuit();
}

function getPinPoint(component: CircuitComponent, pin: CircuitComponent["pins"][number]): { x: number; y: number } {
  return {
    x: component.position.x + (pin.offset?.x ?? 0),
    y: component.position.y + (pin.offset?.y ?? 0),
  };
}

function getNodePoint(document: CircuitDocument, nodeId: string): { x: number; y: number } | null {
  const [componentId, pinId] = nodeId.split(":");
  const component = document.components.find((candidate) => candidate.id === componentId);
  const pin = component?.pins.find((candidate) => candidate.id === pinId);
  if (!component || !pin) {
    return null;
  }

  return getPinPoint(component, pin);
}

function valueColor(value: string | undefined): string {
  if (value === "1") {
    return "#71d6a2";
  }

  if (value === "0") {
    return "#66758a";
  }

  return "#f1bb70";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export function CircuitWorkspace({ project, onBack, onDelete, onUpdateCircuit }: CircuitWorkspaceProps) {
  const [circuit, setCircuit] = useState<CircuitDocument>(() => getCircuit(project));
  const [past, setPast] = useState<CircuitDocument[]>([]);
  const [future, setFuture] = useState<CircuitDocument[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingWire, setPendingWire] = useState<WireEndpoint | null>(null);
  const [wireError, setWireError] = useState("");
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [pointerPosition, setPointerPosition] = useState({ x: 500, y: 450 });
  const [pointerInside, setPointerInside] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [simulation, setSimulation] = useState(() => simulateDigitalCircuit(getCircuit(project)));
  const [waveform, setWaveform] = useState<DigitalWaveform | null>(null);
  const [truthTable, setTruthTable] = useState<TruthTableResult | null>(null);
  const [truthTableNote, setTruthTableNote] = useState("");
  const [netlistCopied, setNetlistCopied] = useState(false);
  const dragStartRef = useRef<CircuitDocument | null>(null);
  const clipboardRef = useRef<CircuitDocument | null>(null);
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const simStateRef = useRef<SimulationState | undefined>(undefined);

  useEffect(() => {
    const next = getCircuit(project);
    simStateRef.current = undefined;
    setCircuit(next);
    setPast([]);
    setFuture([]);
    setSelectedIds([]);
    setPendingWire(null);
    setWireError("");
    setWaveform(null);
  }, [project.id]);

  useEffect(() => {
    const result = simulateDigitalCircuit(circuit, { initialState: simStateRef.current });
    simStateRef.current = result.state;
    setSimulation(result);
    setTruthTable(null);
    setTruthTableNote("");
  }, [circuit]);

  useEffect(() => {
    setSaveState("saving");
    const timer = window.setTimeout(() => setSaveState("saved"), 350);
    return () => window.clearTimeout(timer);
  }, [circuit]);

  const selectedIdSet = new Set(selectedIds);
  const selectedComponent = selectedIds.length === 1 ? circuit.components.find((component) => component.id === selectedIds[0]) ?? null : null;
  const selectedValue = selectedComponent ? simulation.componentValues[selectedComponent.id] : undefined;
  const errorCount = simulation.issues.filter((issue) => issue.severity === "error").length;
  const warningCount = simulation.issues.filter((issue) => issue.severity === "warning").length;
  const netlist = buildNetlist(circuit);
  const netlistText = toSpiceNetlist(circuit);

  const normalizedQuery = paletteQuery.trim().toLowerCase();
  const filteredPalette = paletteGroups
    .map(([category, definitions]) => [category, definitions.filter((definition) => normalizedQuery.length === 0
      || definition.label.toLowerCase().includes(normalizedQuery)
      || definition.type.toLowerCase().includes(normalizedQuery)
      || (definition.shortLabel ?? "").toLowerCase().includes(normalizedQuery)
      || category.toLowerCase().includes(normalizedQuery))] as [string, typeof componentDefinitions[string][]])
    .filter(([, definitions]) => definitions.length > 0);

  function applyDocument(next: CircuitDocument) {
    setCircuit(next);
    setWaveform(null);
    onUpdateCircuit(project.id, next);
  }

  function commit(next: CircuitDocument, options: { history?: boolean } = {}) {
    if (options.history !== false) {
      setPast(pushPast(past, circuit));
      setFuture([]);
    }

    applyDocument(next);
  }

  function undo() {
    const step = undoStep(past, future, circuit);
    if (!step) {
      return;
    }

    setPast(step.past);
    setFuture(step.future);
    applyDocument(step.present);
  }

  function redo() {
    const step = redoStep(past, future, circuit);
    if (!step) {
      return;
    }

    setPast(step.past);
    setFuture(step.future);
    applyDocument(step.present);
  }

  async function copyNetlist() {
    try {
      await navigator.clipboard.writeText(toSpiceNetlist(circuit));
      setNetlistCopied(true);
      window.setTimeout(() => setNetlistCopied(false), 1800);
    } catch {
      setNetlistCopied(false);
    }
  }

  function getCanvasPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) {
      return { x: canvasWidth / 2, y: canvasHeight / 2 };
    }

    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvasWidth, ((event.clientX - bounds.left) / bounds.width) * canvasWidth / zoom)),
      y: Math.max(0, Math.min(canvasHeight, ((event.clientY - bounds.top) / bounds.height) * canvasHeight / zoom)),
    };
  }

  function handleCanvasPointerDown() {
    setSelectedIds([]);
    setPendingWire(null);
    setWireError("");
  }

  function handleCanvasPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const point = getCanvasPoint(event);
    setPointerPosition(point);
    setPointerInside(true);
    if (!dragging) {
      return;
    }

    const gridSize = circuit.gridSize ?? 20;
    const dx = Math.round((point.x - dragging.pointerStart.x) / gridSize) * gridSize;
    const dy = Math.round((point.y - dragging.pointerStart.y) / gridSize) * gridSize;
    setCircuit({
      ...circuit,
      components: circuit.components.map((component) => {
        const start = dragging.startPositions[component.id];
        if (!start) {
          return component;
        }

        return { ...component, position: { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) } };
      }),
    });
  }

  function handleCanvasPointerUp() {
    if (dragging && dragStartRef.current && dragStartRef.current !== circuit) {
      setPast((current) => [...current, dragStartRef.current as CircuitDocument].slice(-60));
      setFuture([]);
      onUpdateCircuit(project.id, circuit);
    }

    setDragging(null);
    dragStartRef.current = null;
  }

  function handleComponentPointerDown(event: React.PointerEvent<SVGGElement>, component: CircuitComponent) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    let nextSelection: string[];

    if (additive) {
      nextSelection = selectedIds.includes(component.id)
        ? selectedIds.filter((id) => id !== component.id)
        : [...selectedIds, component.id];
      setSelectedIds(nextSelection);
      if (!nextSelection.includes(component.id)) {
        return;
      }
    } else {
      nextSelection = selectedIds.includes(component.id) ? selectedIds : [component.id];
      setSelectedIds(nextSelection);
    }

    setWireError("");
    setPendingWire(null);
    const point = getCanvasPoint(event);
    const startPositions: Record<string, { x: number; y: number }> = {};
    for (const id of nextSelection) {
      const candidate = circuit.components.find((current) => current.id === id);
      if (candidate) {
        startPositions[id] = { ...candidate.position };
      }
    }

    dragStartRef.current = circuit;
    setDragging({ pointerStart: point, startPositions });
  }

  function handlePinClick(event: React.MouseEvent<SVGCircleElement>, endpoint: WireEndpoint, direction: string) {
    event.stopPropagation();
    if (direction !== "output" && direction !== "power" && !pendingWire) {
      setWireError("Start a wire from an output or power pin.");
      return;
    }

    if (!pendingWire) {
      setPendingWire(endpoint);
      setWireError("");
      return;
    }

    if (pendingWire.componentId === endpoint.componentId && pendingWire.pinId === endpoint.pinId) {
      setPendingWire(null);
      setWireError("");
      return;
    }

    const nextCircuit = connectPins(circuit, pendingWire, endpoint);
    if (nextCircuit === circuit) {
      setWireError("Connect an output pin to an input pin on another component.");
      return;
    }

    setPendingWire(null);
    setWireError("");
    commit(nextCircuit);
  }

  function selectionSource(): CircuitDocument {
    const idSet = new Set(selectedIds);
    const components = circuit.components.filter((component) => idSet.has(component.id));
    const nets = circuit.nets
      .map((net) => ({ ...net, nodeIds: net.nodeIds.filter((nodeId) => idSet.has(nodeId.split(":")[0])) }))
      .filter((net) => net.nodeIds.length > 1);
    return { components, nets, gridSize: circuit.gridSize };
  }

  function insertClone(source: CircuitDocument, offset: number) {
    if (source.components.length === 0) {
      return;
    }

    const idMap = new Map<string, string>();
    const components = source.components.map((component) => {
      const id = uniqueId(component.type);
      idMap.set(component.id, id);
      return {
        ...component,
        id,
        position: { x: Math.max(0, component.position.x + offset), y: Math.max(0, component.position.y + offset) },
        pins: component.pins.map((pin) => ({ ...pin, offset: { ...(pin.offset ?? { x: 0, y: 0 }) } })),
      };
    });
    const nets = source.nets
      .map((net) => ({
        ...net,
        id: uniqueId("net"),
        name: `${net.name} copy`,
        nodeIds: net.nodeIds
          .map((nodeId) => {
            const [componentId, pinId] = nodeId.split(":");
            const mapped = idMap.get(componentId);
            return mapped ? `${mapped}:${pinId}` : "";
          })
          .filter((nodeId) => nodeId.length > 0),
      }))
      .filter((net) => net.nodeIds.length > 1);

    commit({ ...circuit, components: [...circuit.components, ...components], nets: [...circuit.nets, ...nets] });
    setSelectedIds(components.map((component) => component.id));
  }

  function copySelection() {
    const selection = selectionSource();
    if (selection.components.length > 0) {
      clipboardRef.current = selection;
    }
  }

  function pasteClipboard() {
    if (clipboardRef.current) {
      insertClone(clipboardRef.current, circuit.gridSize ?? 20);
    }
  }

  function duplicateSelection() {
    insertClone(selectionSource(), circuit.gridSize ?? 20);
  }

  function deleteSelection() {
    if (selectedIds.length === 0) {
      return;
    }

    let next = circuit;
    for (const id of selectedIds) {
      next = removeComponent(next, id);
    }
    commit(next);
    setSelectedIds([]);
    setPendingWire(null);
  }

  function nudgeSelection(dx: number, dy: number) {
    if (selectedIds.length === 0) {
      return;
    }

    const idSet = new Set(selectedIds);
    commit({
      ...circuit,
      components: circuit.components.map((component) => idSet.has(component.id)
        ? { ...component, position: { x: Math.max(0, component.position.x + dx), y: Math.max(0, component.position.y + dy) } }
        : component),
    });
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (meta && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if (meta && key === "y") {
        event.preventDefault();
        redo();
        return;
      }

      if (meta && key === "c") {
        copySelection();
        return;
      }

      if (meta && key === "v") {
        event.preventDefault();
        pasteClipboard();
        return;
      }

      if (meta && key === "d") {
        event.preventDefault();
        duplicateSelection();
        return;
      }

      if (meta && key === "a") {
        event.preventDefault();
        setSelectedIds(circuit.components.map((component) => component.id));
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedIds.length > 0) {
          event.preventDefault();
          deleteSelection();
        }
        return;
      }

      if (event.key === "Escape") {
        setSelectedIds([]);
        setPendingWire(null);
        setWireError("");
        return;
      }

      const step = circuit.gridSize ?? 20;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        nudgeSelection(0, -step);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        nudgeSelection(0, step);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        nudgeSelection(-step, 0);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        nudgeSelection(step, 0);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function addComponent(type: string) {
    const gridSize = circuit.gridSize ?? 20;
    const index = circuit.components.length;
    const base = pointerInside
      ? pointerPosition
      : { x: 100 + (index % 4) * 190, y: 110 + Math.floor(index / 4) * 150 };
    const position = {
      x: Math.round(base.x / gridSize) * gridSize,
      y: Math.round(base.y / gridSize) * gridSize,
    };
    const component = createCircuitComponent(type, position);
    commit({ ...circuit, components: [...circuit.components, component] });
    setSelectedIds([component.id]);
    setPendingWire(null);
    setWireError("");
  }

  function rotateSelection() {
    if (selectedIds.length === 0) {
      return;
    }

    let next = circuit;
    for (const id of selectedIds) {
      next = rotateComponent(next, id);
    }
    commit(next);
  }

  function singleSelection(): CircuitComponent | null {
    if (selectedIds.length !== 1) {
      return null;
    }

    return circuit.components.find((component) => component.id === selectedIds[0]) ?? null;
  }

  function toggleSelectedValue() {
    const selected = singleSelection();
    if (!selected || !["switch", "clock"].includes(selected.type)) {
      return;
    }

    commit(setComponentValue(circuit, selected.id, selected.value === "1" ? "0" : "1"));
  }

  function pulseSelectedClock() {
    const selected = singleSelection();
    if (!selected || selected.type !== "clock") {
      return;
    }

    const high = setComponentValue(circuit, selected.id, "1");
    const highResult = simulateDigitalCircuit(high, { initialState: simStateRef.current });
    const low = setComponentValue(high, selected.id, "0");
    const lowResult = simulateDigitalCircuit(low, { initialState: highResult.state });
    simStateRef.current = lowResult.state;
    commit(low);
  }

  function toggleDisplayPolarity() {
    const selected = singleSelection();
    if (!selected || selected.type !== "display7") {
      return;
    }

    commit(setComponentParameter(circuit, selected.id, "anode", selected.parameters?.anode === "anode" ? "cathode" : "anode"));
  }

  function zoomToFit() {
    if (circuit.components.length === 0) {
      setZoom(1);
      return;
    }

    const boxes = circuit.components.map((component) => {
      const definition = getComponentDefinition(component.type);
      return {
        minX: component.position.x,
        minY: component.position.y,
        maxX: component.position.x + (definition?.width ?? 100),
        maxY: component.position.y + (definition?.height ?? 80),
      };
    });
    const minX = Math.min(...boxes.map((box) => box.minX));
    const minY = Math.min(...boxes.map((box) => box.minY));
    const maxX = Math.max(...boxes.map((box) => box.maxX));
    const maxY = Math.max(...boxes.map((box) => box.maxY));
    const padding = 80;
    const width = Math.max(1, maxX - minX) + padding * 2;
    const height = Math.max(1, maxY - minY) + padding * 2;
    const nextZoom = Math.min(1.5, Math.max(0.3, Math.min(canvasWidth / width, canvasHeight / height)));
    setZoom(Number(nextZoom.toFixed(2)));
  }

  function loadTrainerExample() {
    if (circuit.components.length > 0 && !window.confirm("Replace the current schematic with the counter and 7-segment trainer example?")) {
      return;
    }

    simStateRef.current = undefined;
    commit(createTrainerCounterExample());
    setSelectedIds(["trainer-clock"]);
    setPendingWire(null);
    setWireError("");
  }

  function loadExample() {
    if (circuit.components.length > 0 && !window.confirm("Replace the current schematic with the AND-gate example?")) {
      return;
    }

    commit(createExampleCircuit());
    setSelectedIds(["example-and"]);
    setPendingWire(null);
    setWireError("");
  }

  function clearCircuit() {
    if (circuit.components.length > 0 && !window.confirm("Clear every component and wire from this schematic?")) {
      return;
    }

    simStateRef.current = undefined;
    commit(emptyCircuit());
    setSelectedIds([]);
    setPendingWire(null);
    setWireError("");
  }

  function captureWaveform() {
    if (circuit.components.length === 0) {
      return;
    }

    setWaveform(captureDigitalWaveform(circuit, { maxSamples: 16, stepNs: 10 }));
  }

  function generateTruthTable() {
    const result = buildTruthTable(circuit);
    if (!result) {
      setTruthTable(null);
      setTruthTableNote("Add 1–8 switches or clocks and at least one LED, probe or 7-segment display to build a truth table.");
      return;
    }

    setTruthTable(result);
    setTruthTableNote("");
  }

  function renderComponent(component: CircuitComponent) {
    const definition = getComponentDefinition(component.type);
    if (!definition) {
      return null;
    }

    const isSelected = selectedIdSet.has(component.id);
    const outputValue = simulation.componentValues[component.id];
    const rotation = component.rotation ?? 0;

    return (
      <g
        className={`schematic-component ${isSelected ? "is-selected" : ""}`}
        key={component.id}
        onPointerDown={(event) => handleComponentPointerDown(event, component)}
        transform={`translate(${component.position.x} ${component.position.y}) rotate(${rotation} ${definition.width / 2} ${definition.height / 2})`}
      >
        <rect className="component-body" height={definition.height} rx="8" width={definition.width} />
        {component.type === "and" || component.type === "nand" ? <path className="component-glyph" d={`M 20 12 C 30 12 ${definition.width - 24} 24 ${definition.width - 24} 39 C ${definition.width - 24} 54 30 66 20 66 Z`} /> : null}
        {component.type === "or" || component.type === "nor" ? <path className="component-glyph" d={`M 20 12 C 42 24 ${definition.width - 40} 24 ${definition.width - 24} 39 C ${definition.width - 40} 54 42 54 20 66 C 30 48 30 30 20 12 Z`} /> : null}
        {component.type === "xor" || component.type === "xnor" ? <path className="component-glyph" d={`M 30 12 C 52 24 ${definition.width - 40} 24 ${definition.width - 24} 39 C ${definition.width - 40} 54 52 54 30 66 C 40 48 40 30 30 12 Z`} /> : null}
        {component.type === "not" ? <><path className="component-glyph" d={`M 24 18 L ${definition.width - 26} 39 L 24 60 Z`} /><circle className="component-bubble" cx={definition.width - 20} cy="39" r="5" /></> : null}
        {component.type === "switch" ? <><line className="switch-track" x1="26" x2="66" y1="48" y2="48" /><line className="switch-arm" x1="30" x2="64" y1="46" y2="18" /><circle className="switch-terminal" cx="30" cy="48" r="4" /><circle className="switch-terminal" cx="64" cy="48" r="4" /></> : null}
        {component.type === "clock" ? <><rect className="clock-box" height="46" rx="6" width="66" x="13" y="8" /><path className="clock-wave" d="M 20 31 h8 l6 -14 l6 28 l6 -28 l6 28 l6 -14 h8" /></> : null}
        {component.type === "led" ? <><circle className="led-body" cx="46" cy="31" r="17" /><path className="led-rays" d="M46 7v7M46 48v7M22 31h7M63 31h7M29 14l5 5M58 43l5 5M63 14l-5 5M34 43l-5 5" /></> : null}
        {component.type === "vcc" || component.type === "gnd" ? <><text className="power-symbol" x="24" y="43">{component.type === "vcc" ? "+5V" : "GND"}</text><path className="power-line" d={component.type === "vcc" ? "M56 43h20M66 33v20" : "M56 28v20M50 48h12M54 54h4"} /></> : null}
        {definition.units ? <><rect className="ic-outline" height={definition.height} rx="7" width={definition.width} /><path className="ic-notch" d={`M ${definition.width / 2 - 13} 0 a 13 13 0 0 1 26 0`} />{definition.units.map((unit) => { const ys = component.pins.filter((pin) => pin.unitId === unit.id).map((pin) => pin.offset?.y ?? 0); const top = Math.min(...ys) - 15; const bottom = Math.max(...ys) + 15; return <g key={unit.id}><line className="ic-divider" x1="12" x2={definition.width - 12} y1={bottom} y2={bottom} /><text className="ic-unit-label" x="17" y={top + 13}>{unit.label}</text></g>; })}</> : null}
        {component.type === "display7" ? <g className="seven-segment-glyph">{Object.entries(sevenSegmentPaths).map(([segment, path]) => <path className={simulation.displays[component.id]?.segments[segment] ? "is-lit" : ""} d={path} key={segment} />)}<circle className={simulation.displays[component.id]?.segments.dp ? "is-lit" : ""} cx="110" cy="170" r="5" /></g> : null}
        <text className="component-label" x={definition.width / 2} y={definition.height - 10} textAnchor="middle">{component.label}</text>
        {component.pins.map((pin) => {
          const point = pin.offset ?? { x: 0, y: 0 };
          const nodeValue = simulation.nodeValues[pinNodeId(component.id, pin.id)];
          return (
            <g key={pin.id} onPointerDown={(event) => event.stopPropagation()}>
              <circle className={`pin-dot pin-${pin.direction}`} cx={point.x} cy={point.y} onClick={(event) => handlePinClick(event, { componentId: component.id, pinId: pin.id }, pin.direction)} r="6" style={{ fill: valueColor(nodeValue) }} />
              <text className={`pin-label pin-label-${pin.direction}`} x={pin.direction === "output" || pin.direction === "power" ? point.x - 8 : point.x + 8} y={point.y + 3} textAnchor={pin.direction === "output" || pin.direction === "power" ? "end" : "start"}>{pin.name}</text>
            </g>
          );
        })}
        {outputValue ? <text className="component-value" x={definition.width - 9} y="14" textAnchor="end">{formatDigitalValue(outputValue)}</text> : null}
      </g>
    );
  }

  function renderNet(net: CircuitDocument["nets"][number]) {
    const points = net.nodeIds.map((nodeId) => getNodePoint(circuit, nodeId)).filter((point): point is { x: number; y: number } => point !== null);
    if (points.length < 2) {
      return null;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const midX = (first.x + last.x) / 2;
    const value = simulation.nodeValues[net.nodeIds[0]];
    return (
      <g className="schematic-net" key={net.id}>
        <path d={`M ${first.x} ${first.y} H ${midX} V ${last.y} H ${last.x}`} style={{ stroke: valueColor(value) }} />
        <text x={midX + 5} y={(first.y + last.y) / 2 - 6}>{net.name}</text>
      </g>
    );
  }

  const pendingPoint = pendingWire ? getNodePoint(circuit, pinNodeId(pendingWire.componentId, pendingWire.pinId)) : null;

  return (
    <div className="circuit-workspace">
      <div className="circuit-topline">
        <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> All projects</button>
        <div className="circuit-breadcrumb"><span>Circuit Lab</span><Icon name="chevron-right" size={14} /><span>Schematic</span></div>
      </div>

      <header className="circuit-header">
        <div>
          <span className="eyebrow">Editable schematic</span>
          <h1>{project.name}</h1>
          <p>{project.description || "Place digital sources and gates, then connect their pins."}</p>
        </div>
        <div className="circuit-header-actions">
          <button className="button button-secondary" onClick={loadTrainerExample} type="button"><Icon name="grid" size={16} /> Trainer example</button>
          <button className="button button-secondary" onClick={loadExample} type="button"><Icon name="layers" size={16} /> Load example</button>
          <button className="button button-secondary" disabled={circuit.components.length === 0} onClick={captureWaveform} type="button"><Icon name="activity" size={16} /> Capture waveform</button>
          <button className="button button-secondary" disabled={circuit.components.length === 0} onClick={generateTruthTable} type="button"><Icon name="grid" size={16} /> Truth table</button>
        </div>
      </header>

      <div className="circuit-toolbar">
        <div className="circuit-toolbar-group">
          <button className="toolbar-icon-button" aria-label="Undo" disabled={past.length === 0} onClick={undo} title="Undo (Ctrl+Z)" type="button"><Icon name="undo" size={15} /></button>
          <button className="toolbar-icon-button" aria-label="Redo" disabled={future.length === 0} onClick={redo} title="Redo (Ctrl+Shift+Z)" type="button"><Icon name="redo" size={15} /></button>
        </div>
        <div className="circuit-toolbar-group">
          <button className="toolbar-icon-button" aria-label="Duplicate selection" disabled={selectedIds.length === 0} onClick={duplicateSelection} title="Duplicate (Ctrl+D)" type="button"><Icon name="copy" size={15} /></button>
          <button className="toolbar-icon-button" aria-label="Rotate selection" disabled={selectedIds.length === 0} onClick={rotateSelection} title="Rotate selection" type="button"><Icon name="refresh" size={15} /></button>
          <button className="toolbar-icon-button" aria-label="Delete selection" disabled={selectedIds.length === 0} onClick={deleteSelection} title="Delete selection" type="button"><Icon name="trash" size={15} /></button>
        </div>
        <div className="circuit-toolbar-group"><span className="toolbar-label">Selected</span><span className="toolbar-value">{selectedIds.length}</span></div>
        <div className="circuit-toolbar-spacer" />
        <div className="circuit-toolbar-group">
          <button className="toolbar-icon-button" aria-label="Zoom out" onClick={() => setZoom((current) => Math.max(0.3, Number((current - 0.1).toFixed(2))))} title="Zoom out" type="button">-</button>
          <span className="toolbar-value">{Math.round(zoom * 100)}%</span>
          <button className="toolbar-icon-button" aria-label="Zoom in" onClick={() => setZoom((current) => Math.min(1.5, Number((current + 0.1).toFixed(2))))} title="Zoom in" type="button">+</button>
          <button className="toolbar-icon-button" aria-label="Zoom to fit" onClick={zoomToFit} title="Zoom to fit" type="button"><Icon name="target" size={15} /></button>
        </div>
        <button className="toolbar-clear" onClick={clearCircuit} type="button"><Icon name="trash" size={14} /> Clear</button>
      </div>

      <div className="circuit-layout">
        <aside className="component-palette">
          <div className="panel-heading"><div><span className="eyebrow">Library</span><h2>Components</h2></div><span className="palette-count">{Object.keys(componentDefinitions).length}</span></div>
          <label className="search-field palette-search">
            <Icon name="search" size={15} />
            <span className="sr-only">Search components</span>
            <input value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder="Search components" type="search" />
          </label>
          <p className="palette-help">Click a component to place it at the cursor.</p>
          <div className="palette-list">
            {filteredPalette.map(([category, definitions]) => (
              <div className="palette-group" key={category}>
                <span className="palette-group-label">{category}</span>
                {definitions.map((definition) => (
                  <button className="palette-item" key={definition.type} onClick={() => addComponent(definition.type)} title={definition.description} type="button">
                    <span className={`palette-icon palette-${definition.category.toLowerCase().replaceAll(" ", "-")}`}><Icon name={definition.type === "led" || definition.type === "display7" ? "activity" : definition.category === "Power" ? "layers" : "circuit"} size={16} /></span>
                    <span><strong>{definition.shortLabel ?? definition.label}</strong><small>{definition.label}</small></span>
                    <Icon name="plus" size={14} />
                  </button>
                ))}
              </div>
            ))}
            {filteredPalette.length === 0 ? <div className="simulation-empty">No components match “{paletteQuery}”.</div> : null}
          </div>
          <div className="palette-tip"><Icon name="activity" size={15} /><span>Click an output pin, then an input pin, to create a wire.</span></div>
        </aside>

        <section className="schematic-panel">
          <div className="schematic-panel-header"><div><strong>Schematic canvas</strong><span>{circuit.components.length} components · {circuit.nets.length} nets · {selectedIds.length} selected</span></div><span className="canvas-mode-label"><span className={`status-dot ${saveState === "saving" ? "is-busy" : ""}`} /> {saveState === "saving" ? "Saving…" : "All changes saved"}</span></div>
          <div className="schematic-canvas-wrap">
            <svg
              aria-label="Circuit schematic canvas"
              className="schematic-canvas"
              onPointerDown={handleCanvasPointerDown}
              onPointerLeave={() => setPointerInside(false)}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              ref={canvasRef}
              role="img"
              viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
            >
              <defs>
                <pattern height="20" id="small-grid" patternUnits="userSpaceOnUse" width="20"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(151, 177, 211, 0.07)" strokeWidth="1" /></pattern>
                <pattern height="100" id="large-grid" patternUnits="userSpaceOnUse" width="100"><rect fill="url(#small-grid)" height="100" width="100" /><path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(151, 177, 211, 0.12)" strokeWidth="1" /></pattern>
              </defs>
              <rect className="canvas-background" height={canvasHeight} onPointerDown={handleCanvasPointerDown} width={canvasWidth} x="0" y="0" />
              <rect fill="url(#large-grid)" height={canvasHeight} pointerEvents="none" width={canvasWidth} x="0" y="0" />
              <g transform={`scale(${zoom})`}>
                {circuit.nets.map((net) => renderNet(net))}
                {circuit.components.map((component) => renderComponent(component))}
                {pendingWire && pendingPoint ? <path className="pending-wire" d={`M ${pendingPoint.x} ${pendingPoint.y} L ${pointerPosition.x} ${pointerPosition.y}`} /> : null}
              </g>
            </svg>
            {circuit.components.length === 0 ? <div className="canvas-empty"><div className="canvas-empty-icon"><Icon name="circuit" size={25} /></div><strong>Start your schematic</strong><span>Place a switch and a gate from the component library.</span><button className="text-button" onClick={loadExample} type="button">Load AND-gate example <Icon name="chevron-right" size={15} /></button></div> : null}
            {wireError ? <div className="wire-error"><Icon name="activity" size={15} /> {wireError}</div> : null}
          </div>
          <div className="schematic-panel-footer"><span><Icon name="grid" size={14} /> Click and drag to move; shift-click to add to selection</span><span><Icon name="circuit" size={14} /> Ctrl+C / Ctrl+V / Ctrl+D / Delete</span><span><Icon name="save" size={14} /> Changes save automatically</span></div>
        </section>

        <aside className="circuit-inspector">
          <div className="panel-heading"><div><span className="eyebrow">Inspector</span><h2>Properties</h2></div>{selectedComponent ? <span className="inspector-id">{selectedComponent.id.slice(0, 8)}</span> : selectedIds.length > 1 ? <span className="inspector-id">{selectedIds.length} selected</span> : null}</div>
          {selectedComponent ? (
            <div className="inspector-content">
              <div className="inspector-component-heading"><span className="inspector-component-icon"><Icon name="circuit" size={18} /></span><div><strong>{selectedComponent.label}</strong><small>{selectedComponent.type}</small></div></div>
              <div className="inspector-field"><span>Position</span><strong>{Math.round(selectedComponent.position.x)}, {Math.round(selectedComponent.position.y)}</strong></div>
              <div className="inspector-field"><span>Rotation</span><strong>{selectedComponent.rotation}°</strong></div>
              <div className="inspector-field"><span>Simulated value</span><strong className={`digital-value digital-${selectedValue ?? "x"}`}>{formatDigitalValue(selectedValue)}</strong></div>
              {["switch", "clock"].includes(selectedComponent.type) ? <button className="button button-primary inspector-toggle" onClick={toggleSelectedValue} type="button">Set {selectedComponent.value === "1" ? "LOW" : "HIGH"}</button> : null}
              {selectedComponent.type === "clock" ? <button className="button button-secondary inspector-toggle" onClick={pulseSelectedClock} type="button"><Icon name="activity" size={15} /> Clock pulse</button> : null}
              {selectedComponent.type === "display7" ? <button className="button button-secondary inspector-toggle" onClick={toggleDisplayPolarity} type="button"><Icon name="grid" size={15} /> Common {selectedComponent.parameters?.anode === "anode" ? "cathode" : "anode"}</button> : null}
              <div className="inspector-actions"><button className="button button-secondary" onClick={rotateSelection} type="button">Rotate 90°</button><button className="button button-danger" onClick={deleteSelection} type="button"><Icon name="trash" size={15} /> Delete</button></div>
              <div className="pin-list"><span className="inspector-section-label">Pins</span>{selectedComponent.pins.map((pin) => <div className="pin-list-row" key={pin.id}><span className={`pin-direction-dot pin-direction-${pin.direction}`} /><span>{pin.number}. {pin.name}</span><small>{pin.direction}</small></div>)}</div>
            </div>
          ) : selectedIds.length > 1 ? (
            <div className="inspector-content">
              <p className="palette-help">{selectedIds.length} components selected.</p>
              <div className="inspector-actions"><button className="button button-secondary" onClick={duplicateSelection} type="button">Duplicate</button><button className="button button-danger" onClick={deleteSelection} type="button"><Icon name="trash" size={15} /> Delete</button></div>
            </div>
          ) : (
            <div className="inspector-empty"><div className="inspector-empty-icon"><Icon name="settings" size={21} /></div><strong>Select a component</strong><p>Choose a symbol on the canvas to inspect its pins and value. Shift-click to select several.</p></div>
          )}
        </aside>
      </div>

      <section className="simulation-results">
        <div className="simulation-results-header"><div><span className="eyebrow">Deterministic digital engine</span><h2>Simulation results</h2></div><div className="simulation-header-actions"><div className={`simulation-health ${errorCount > 0 ? "has-errors" : "is-ready"}`}><span className="status-dot" /> {errorCount > 0 ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : "Ready to simulate"}{warningCount > 0 ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}</div></div></div>
        <div className="simulation-body">
          <div className="simulation-output-panel"><div className="simulation-panel-title"><strong>Component values</strong><span>{circuit.components.length} components</span></div>{circuit.components.length > 0 ? <div className="value-table">{circuit.components.map((component) => { const units = getComponentDefinition(component.type)?.units ?? []; const display = simulation.displays[component.id]; return (<div className="value-row" key={component.id}><span>{component.label}{display ? ` · shows ${display.glyph}` : ""}</span><span className="value-cell-group">{units.length > 0 ? units.map((unit) => { const key = unitStateKey(component.id, unit.id); const value = simulation.unitValues[key]; return <span className={`digital-value digital-${value ?? "x"}`} key={key}>{unit.label} {formatDigitalValue(value)}</span>; }) : <span className={`digital-value digital-${simulation.componentValues[component.id] ?? "x"}`}>{formatDigitalValue(simulation.componentValues[component.id])}</span>}</span></div>); })}</div> : <div className="simulation-empty">Place components to see deterministic logic values.</div>}</div>
          <div className="simulation-issues-panel"><div className="simulation-panel-title"><strong>Validation</strong><span>{simulation.issues.length} messages</span></div>{simulation.issues.length > 0 ? <div className="issue-list">{simulation.issues.map((issue, index) => <div className={`issue-row issue-${issue.severity}`} key={`${issue.code}-${index}`}><span className="issue-code">{issue.code}</span><span>{issue.message}</span></div>)}</div> : <div className="simulation-empty success-empty"><Icon name="check" size={17} /> No validation messages.</div>}</div>
        </div>
      </section>

      <section className="netlist-panel">
        <div className="simulation-results-header"><div><span className="eyebrow">Connectivity</span><h2>Netlist</h2></div><div className="simulation-header-actions"><span className="status-pill">{netlist.nets.length} nets · {netlist.components.length} parts</span><button className="button button-secondary" onClick={copyNetlist} type="button"><Icon name="save" size={15} /> {netlistCopied ? "Copied" : "Copy netlist"}</button></div></div>
        <div className="netlist-body">
          <div className="netlist-nets">
            {netlist.nets.length > 0 ? netlist.nets.map((net) => <div className="netlist-net-row" key={net.id}><strong>{net.name}</strong><span>{net.drivers.length > 0 ? net.drivers.map((node) => `${node.componentLabel}.${node.pinName}`).join(", ") : "no driver"}</span><small>→ {net.sinks.length > 0 ? net.sinks.map((node) => `${node.componentLabel}.${node.pinName}`).join(", ") : "no load"}</small></div>) : <div className="simulation-empty">Connect pins to build nets.</div>}
          </div>
          <pre className="netlist-code">{netlistText}</pre>
        </div>
      </section>

      {waveform ? <WaveformViewer waveform={waveform} /> : null}

      {(truthTable || truthTableNote) ? (
        <section className="truth-table-panel">
          <div className="simulation-results-header">
            <div><span className="eyebrow">Exhaustive simulation</span><h2>Truth table</h2></div>
            <div className="simulation-header-actions">
              {truthTable ? <span className="status-pill">{truthTable.rows.length} rows · {truthTable.inputs.length} inputs{truthTable.truncated ? " · truncated" : ""}</span> : null}
              <button className="button button-secondary" onClick={() => { setTruthTable(null); setTruthTableNote(""); }} type="button"><Icon name="x" size={15} /> Close</button>
            </div>
          </div>
          {truthTable ? (
            <div className="truth-table-wrap">
              <table className="truth-table">
                <thead>
                  <tr>
                    {truthTable.inputs.map((column) => <th key={column.id} scope="col">{column.label}</th>)}
                    {truthTable.outputs.map((column) => <th key={column.id} scope="col">{column.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {truthTable.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.inputs.map((value, inputIndex) => <td key={`in-${inputIndex}`}><span className={`digital-value digital-${value}`}>{formatDigitalValue(value)}</span></td>)}
                      {row.outputs.map((value, outputIndex) => <td key={`out-${outputIndex}`}><span className={`digital-value digital-${["0", "1", "x", "z"].includes(value) ? value : "x"}`}>{value}</span></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="simulation-empty">{truthTableNote}</div>}
        </section>
      ) : null}

      <section className="workspace-danger-zone circuit-danger-zone"><div><strong>Project actions</strong><p>Updated {formatDate(project.updatedAt)} · Changes are stored locally in this project.</p></div><button className="button button-danger" onClick={() => onDelete(project.id)} type="button"><Icon name="trash" size={16} /> Delete project</button></section>
    </div>
  );
}
