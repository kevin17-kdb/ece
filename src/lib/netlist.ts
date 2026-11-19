import { getComponentDefinition, pinNodeId } from "./circuitCatalog";
import type { CircuitDocument, PinDirection } from "../types/project";

export interface NetlistNode {
  nodeId: string;
  componentId: string;
  componentLabel: string;
  pinId: string;
  pinName: string;
  pinNumber: number;
  direction: PinDirection;
  unitId?: string;
}

export interface NetlistNet {
  id: string;
  name: string;
  nodes: NetlistNode[];
  drivers: NetlistNode[];
  sinks: NetlistNode[];
}

export interface NetlistComponent {
  id: string;
  label: string;
  type: string;
  part: string;
  family?: string;
  pinCount: number;
  unitCount: number;
}

export interface CircuitNetlist {
  components: NetlistComponent[];
  nets: NetlistNet[];
  unconnectedPins: NetlistNode[];
}

function buildNode(document: CircuitDocument, nodeId: string): NetlistNode | null {
  const [componentId, pinId] = nodeId.split(":");
  const component = document.components.find((candidate) => candidate.id === componentId);
  const pin = component?.pins.find((candidate) => candidate.id === pinId);
  if (!component || !pin) {
    return null;
  }

  return {
    nodeId,
    componentId: component.id,
    componentLabel: component.label,
    pinId: pin.id,
    pinName: pin.name,
    pinNumber: pin.number,
    direction: pin.direction,
    unitId: pin.unitId,
  };
}

export function buildNetlist(document: CircuitDocument): CircuitNetlist {
  const components: NetlistComponent[] = document.components.map((component) => {
    const definition = getComponentDefinition(component.type);
    return {
      id: component.id,
      label: component.label,
      type: component.type,
      part: definition?.shortLabel ?? component.type.toUpperCase(),
      family: definition?.family,
      pinCount: Math.max(...component.pins.map((pin) => pin.number), component.pins.length),
      unitCount: definition?.units?.length ?? 0,
    };
  });

  const nets: NetlistNet[] = document.nets.map((net) => {
    const nodes = net.nodeIds.map((nodeId) => buildNode(document, nodeId)).filter((node): node is NetlistNode => node !== null);
    return {
      id: net.id,
      name: net.name,
      nodes,
      drivers: nodes.filter((node) => node.direction === "output"),
      sinks: nodes.filter((node) => node.direction === "input" || node.direction === "power"),
    };
  });

  const connectedNodeIds = new Set(document.nets.flatMap((net) => net.nodeIds));
  const unconnectedPins: NetlistNode[] = document.components
    .flatMap((component) => component.pins
      .filter((pin) => pin.direction === "input")
      .map((pin) => buildNode(document, pinNodeId(component.id, pin.id))))
    .filter((node): node is NetlistNode => node !== null && !connectedNodeIds.has(node.nodeId));

  return { components, nets, unconnectedPins };
}

function netNameFor(netlist: CircuitNetlist, nodeId: string): string {
  const net = netlist.nets.find((candidate) => candidate.nodes.some((node) => node.nodeId === nodeId));
  return net ? net.name : "NC";
}

function primitiveName(type: string): string {
  const names: Record<string, string> = {
    and: "AND",
    or: "OR",
    not: "NOT",
    nand: "NAND",
    nor: "NOR",
    xor: "XOR",
    xnor: "XNOR",
    buffer: "BUF",
  };
  return names[type] ?? type.toUpperCase();
}

export function toSpiceNetlist(document: CircuitDocument): string {
  const netlist = buildNetlist(document);
  const lines: string[] = [];
  lines.push("* Digital netlist - Universal Electronics Lab");
  lines.push(`* ${netlist.components.length} components, ${netlist.nets.length} nets`);
  lines.push("* Digital parts only: the deterministic engine evaluates 74xx/40xx logic, not analog SPICE.");
  lines.push("");

  const icLines: string[] = [];
  const gateLines: string[] = [];
  const sourceLines: string[] = [];
  const loadLines: string[] = [];
  let icIndex = 0;
  let gateIndex = 0;
  let sourceIndex = 0;
  let loadIndex = 0;

  for (const component of document.components) {
    const nodeFor = (pinId: string) => netNameFor(netlist, pinNodeId(component.id, pinId));
    const definition = getComponentDefinition(component.type);

    if (definition?.units && definition.units.length > 0) {
      icIndex += 1;
      const pinOrder = [...component.pins].sort((left, right) => left.number - right.number);
      const nodes = pinOrder.map((pin) => nodeFor(pin.id));
      icLines.push(`U${icIndex} ${definition.shortLabel ?? component.type.toUpperCase()} ${nodes.join(" ")}`);
      continue;
    }

    if (["and", "or", "not", "nand", "nor", "xor", "xnor", "buffer"].includes(component.type)) {
      gateIndex += 1;
      const inputs = component.pins.filter((pin) => pin.direction === "input").map((pin) => nodeFor(pin.id));
      const outputs = component.pins.filter((pin) => pin.direction === "output").map((pin) => nodeFor(pin.id));
      gateLines.push(`G${gateIndex} ${primitiveName(component.type)} (${[...outputs, ...inputs].join(" ")})`);
      continue;
    }

    if (["switch", "clock", "vcc", "gnd"].includes(component.type)) {
      sourceIndex += 1;
      const name = component.type === "vcc" ? "VCC" : component.type === "gnd" ? "GND" : component.type === "clock" ? "CLK" : "SW";
      sourceLines.push(`S${sourceIndex} ${name}${sourceIndex} ${nodeFor("out")} ${component.value === "1" ? "HIGH" : "LOW"}`);
      continue;
    }

    if (component.type === "led" || component.type === "display7") {
      loadIndex += 1;
      const node = nodeFor(component.pins[0]?.id ?? "");
      loadLines.push(`D${loadIndex} ${component.type === "led" ? "LED" : "SEVEN_SEG"} ${node}`);
    }
  }

  const sections: [string, string[]][] = [
    ["Integrated circuits", icLines],
    ["Primitive gates", gateLines],
    ["Sources", sourceLines],
    ["Loads", loadLines],
  ];

  for (const [title, entries] of sections) {
    if (entries.length === 0) {
      continue;
    }

    lines.push(`* ${title}`);
    lines.push(...entries);
    lines.push("");
  }

  lines.push("* Nets");
  for (const net of netlist.nets) {
    const pins = net.nodes.map((node) => `${node.componentLabel}.${node.pinName}(${node.pinNumber})`).join(", ");
    lines.push(`* ${net.name}: ${pins}`);
  }

  if (netlist.unconnectedPins.length > 0) {
    lines.push("");
    lines.push("* Unconnected inputs");
    for (const node of netlist.unconnectedPins) {
      lines.push(`* ${node.componentLabel}.${node.pinName}(${node.pinNumber})`);
    }
  }

  return lines.join("\n");
}
