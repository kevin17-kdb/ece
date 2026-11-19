import { createCircuitComponent, pinNodeId } from "./circuitCatalog";
import type { CircuitComponent, CircuitDocument, CircuitNet, DigitalValue } from "../types/project";

function createId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function findPin(document: CircuitDocument, componentId: string, pinId: string) {
  const component = document.components.find((candidate) => candidate.id === componentId);
  return component?.pins.find((pin) => pin.id === pinId);
}

export function connectPins(document: CircuitDocument, from: { componentId: string, pinId: string }, to: { componentId: string, pinId: string }): CircuitDocument {
  const fromPin = findPin(document, from.componentId, from.pinId);
  const toPin = findPin(document, to.componentId, to.pinId);
  if (!fromPin || !toPin) {
    return document;
  }

  const fromIsDriver = fromPin.direction === "output";
  const toIsReceiver = toPin.direction === "input" || toPin.direction === "power";
  if (!fromIsDriver || !toIsReceiver || from.componentId === to.componentId) {
    return document;
  }

  const fromNodeId = pinNodeId(from.componentId, from.pinId);
  const toNodeId = pinNodeId(to.componentId, to.pinId);
  const fromNetIndex = document.nets.findIndex((net) => net.nodeIds.includes(fromNodeId));
  const toNetIndex = document.nets.findIndex((net) => net.nodeIds.includes(toNodeId));

  if (fromNetIndex >= 0 && fromNetIndex === toNetIndex) {
    return document;
  }

  if (fromNetIndex >= 0 && toNetIndex >= 0) {
    const firstNet = document.nets[fromNetIndex];
    const secondNet = document.nets[toNetIndex];
    const mergedNodeIds = [...new Set([...firstNet.nodeIds, ...secondNet.nodeIds, toNodeId])];
    return {
      ...document,
      nets: document.nets
        .map((net, index) => index === fromNetIndex ? { ...net, nodeIds: mergedNodeIds } : net)
        .filter((net) => net.id !== secondNet.id),
    };
  }

  const existingNet = fromNetIndex >= 0 ? document.nets[fromNetIndex] : toNetIndex >= 0 ? document.nets[toNetIndex] : undefined;
  if (existingNet) {
    return {
      ...document,
      nets: document.nets.map((net) => net.id === existingNet.id ? { ...net, nodeIds: [...new Set([...net.nodeIds, fromNodeId, toNodeId])] } : net),
    };
  }

  const net: CircuitNet = {
    id: createId("net"),
    name: `N${document.nets.length + 1}`,
    nodeIds: [fromNodeId, toNodeId],
  };

  return { ...document, nets: [...document.nets, net] };
}

export function removeComponent(document: CircuitDocument, componentId: string): CircuitDocument {
  const nodeIds = new Set(
    document.components
      .filter((component) => component.id === componentId)
      .flatMap((component) => component.pins.map((pin) => pinNodeId(component.id, pin.id))),
  );

  return {
    ...document,
    components: document.components.filter((component) => component.id !== componentId),
    nets: document.nets
      .map((net) => ({ ...net, nodeIds: net.nodeIds.filter((nodeId) => !nodeIds.has(nodeId)) }))
      .filter((net) => net.nodeIds.length > 1),
  };
}

export function moveComponent(document: CircuitDocument, componentId: string, position: { x: number, y: number }): CircuitDocument {
  return {
    ...document,
    components: document.components.map((component) => component.id === componentId ? { ...component, position } : component),
  };
}

export function rotateComponent(document: CircuitDocument, componentId: string): CircuitDocument {
  return {
    ...document,
    components: document.components.map((component) => component.id === componentId ? { ...component, rotation: (component.rotation + 90) % 360 } : component),
  };
}

export function setComponentValue(document: CircuitDocument, componentId: string, value: DigitalValue): CircuitDocument {
  return {
    ...document,
    components: document.components.map((component) => component.id === componentId ? { ...component, value } : component),
  };
}

export function setComponentParameter(document: CircuitDocument, componentId: string, parameter: string, value: string | number | boolean): CircuitDocument {
  return {
    ...document,
    components: document.components.map((component) => component.id === componentId
      ? { ...component, parameters: { ...(component.parameters ?? {}), [parameter]: value } }
      : component),
  };
}

export function createExampleCircuit(): CircuitDocument {
  const switchA = createCircuitComponent("switch", { x: 110, y: 150 }, "example-switch-a");
  const switchB = createCircuitComponent("switch", { x: 110, y: 330 }, "example-switch-b");
  const andGate = createCircuitComponent("and", { x: 390, y: 240 }, "example-and");
  const led = createCircuitComponent("led", { x: 690, y: 249 }, "example-led");

  return {
    gridSize: 20,
    components: [switchA, switchB, andGate, led],
    nets: [
      { id: "example-net-a", name: "A", nodeIds: [pinNodeId(switchA.id, "out"), pinNodeId(andGate.id, "a")] },
      { id: "example-net-b", name: "B", nodeIds: [pinNodeId(switchB.id, "out"), pinNodeId(andGate.id, "b")] },
      { id: "example-net-y", name: "Y", nodeIds: [pinNodeId(andGate.id, "out"), pinNodeId(led.id, "in")] },
    ],
  };
}

export function createTrainerCounterExample(): CircuitDocument {
  const clock = createCircuitComponent("clock", { x: 60, y: 250 }, "trainer-clock");
  const vcc = createCircuitComponent("vcc", { x: 60, y: 90 }, "trainer-vcc");
  const gnd = createCircuitComponent("gnd", { x: 60, y: 430 }, "trainer-gnd");
  const counter = createCircuitComponent("74ls393", { x: 240, y: 120 }, "trainer-counter");
  const leds = [143, 167, 191, 215].map((y, index) => createCircuitComponent("led", { x: 520, y }, `trainer-led-${index}`));
  const decoder = createCircuitComponent("7447", { x: 240, y: 370 }, "trainer-decoder");
  const display = { ...createCircuitComponent("display7", { x: 700, y: 370 }, "trainer-display"), parameters: { anode: "anode" } };

  const counterBits = ["1q0", "1q1", "1q2", "1q3"];
  const decoderSegments = ["a_out", "b_out", "c_out", "d_out", "e", "f", "g"];

  return {
    gridSize: 20,
    components: [clock, vcc, gnd, counter, ...leds, decoder, display],
    nets: [
      { id: "trainer-net-clk", name: "CLK", nodeIds: [pinNodeId(clock.id, "out"), pinNodeId(counter.id, "1cp")] },
      {
        id: "trainer-net-vcc",
        name: "VCC",
        nodeIds: [pinNodeId(vcc.id, "vcc"), pinNodeId(counter.id, "vcc"), pinNodeId(decoder.id, "vcc")],
      },
      {
        id: "trainer-net-gnd",
        name: "GND",
        nodeIds: [pinNodeId(gnd.id, "gnd"), pinNodeId(counter.id, "gnd"), pinNodeId(decoder.id, "gnd")],
      },
      ...counterBits.map((bit, index) => ({
        id: `trainer-net-q${index}`,
        name: `Q${index}`,
        nodeIds: [pinNodeId(counter.id, bit), pinNodeId(leds[index].id, "in"), pinNodeId(decoder.id, ["a", "b", "c", "d"][index] ?? "a")],
      })),
      { id: "trainer-net-lt", name: "LT", nodeIds: [pinNodeId(decoder.id, "lt"), pinNodeId(vcc.id, "vcc")] },
      { id: "trainer-net-rbi", name: "RBI", nodeIds: [pinNodeId(decoder.id, "rbi"), pinNodeId(vcc.id, "vcc")] },
      ...decoderSegments.map((segment, index) => ({
        id: `trainer-net-seg-${index}`,
        name: ["a", "b", "c", "d", "e", "f", "g"][index]?.toUpperCase() ?? "S",
        nodeIds: [pinNodeId(decoder.id, segment), pinNodeId(display.id, ["a", "b", "c", "d", "e", "f", "g"][index] ?? "a")],
      })),
    ],
  };
}

export function cloneComponent(component: CircuitComponent, position: { x: number, y: number }): CircuitComponent {
  return {
    ...component,
    id: createId(component.type),
    label: `${component.label} copy`,
    position,
    pins: component.pins.map((pin) => ({ ...pin, offset: { ...(pin.offset ?? { x: 0, y: 0 }) } })),
  };
}
