import type { CircuitComponent, CircuitPin, DigitalValue } from "../types/project";

export type CircuitUnitKind = "gate" | "dff" | "counter4" | "bcd7seg";

export interface CircuitUnitDefinition {
  id: string;
  label: string;
  kind: CircuitUnitKind;
  gateType?: string;
  inputPinIds: string[];
  outputPinIds: string[];
  clockPinIds?: string[];
  setPinIds?: string[];
  clearPinIds?: string[];
  setActiveLevel?: DigitalValue;
  clearActiveLevel?: DigitalValue;
  edge?: "rising" | "falling";
  stateWidth?: number;
}

export interface ComponentDefinition {
  type: string;
  label: string;
  shortLabel?: string;
  category: string;
  family?: string;
  description: string;
  width: number;
  height: number;
  defaultValue?: DigitalValue;
  parameters?: Record<string, string | number | boolean>;
  pins: CircuitPin[];
  units?: CircuitUnitDefinition[];
}

const inputPin = (id: string, name: string, offset: { x: number; y: number }, number: number): CircuitPin => ({
  id,
  name,
  number,
  direction: "input",
  offset,
});

const outputPin = (id: string, name: string, offset: { x: number; y: number }, number: number): CircuitPin => ({
  id,
  name,
  number,
  direction: "output",
  offset,
});

const powerPin = (id: string, name: string, offset: { x: number; y: number }, number: number, direction: "input" | "output"): CircuitPin => ({
  id,
  name,
  number,
  direction,
  offset,
});

const unitInput = (id: string, name: string, offset: { x: number; y: number }, number: number, unitId: string): CircuitPin => ({
  id,
  name,
  number,
  direction: "input",
  offset,
  unitId,
});

const unitOutput = (id: string, name: string, offset: { x: number; y: number }, number: number, unitId: string): CircuitPin => ({
  id,
  name,
  number,
  direction: "output",
  offset,
  unitId,
});

const icPower = (id: "vcc" | "gnd", name: string, offset: { x: number; y: number }, number: number): CircuitPin => ({
  id,
  name,
  number,
  direction: "power",
  offset,
});

function quadGateUnits(gateType: string): CircuitUnitDefinition[] {
  return [
    { id: "u1", label: "1/4", kind: "gate", gateType, inputPinIds: ["1a", "1b"], outputPinIds: ["1y"] },
    { id: "u2", label: "2/4", kind: "gate", gateType, inputPinIds: ["2a", "2b"], outputPinIds: ["2y"] },
    { id: "u3", label: "3/4", kind: "gate", gateType, inputPinIds: ["3a", "3b"], outputPinIds: ["3y"] },
    { id: "u4", label: "4/4", kind: "gate", gateType, inputPinIds: ["4a", "4b"], outputPinIds: ["4y"] },
  ];
}

const quadGatePins = (): CircuitPin[] => [
  unitInput("1a", "1A", { x: 0, y: 49 }, 1, "u1"),
  unitInput("1b", "1B", { x: 0, y: 75 }, 2, "u1"),
  unitOutput("1y", "1Y", { x: 210, y: 62 }, 3, "u1"),
  unitInput("2a", "2A", { x: 0, y: 105 }, 4, "u2"),
  unitInput("2b", "2B", { x: 0, y: 131 }, 5, "u2"),
  unitOutput("2y", "2Y", { x: 210, y: 118 }, 6, "u2"),
  icPower("gnd", "GND", { x: 105, y: 292 }, 7),
  unitOutput("3y", "3Y", { x: 210, y: 174 }, 8, "u3"),
  unitInput("3a", "3A", { x: 0, y: 161 }, 9, "u3"),
  unitInput("3b", "3B", { x: 0, y: 187 }, 10, "u3"),
  unitOutput("4y", "4Y", { x: 210, y: 230 }, 11, "u4"),
  unitInput("4a", "4A", { x: 0, y: 217 }, 12, "u4"),
  unitInput("4b", "4B", { x: 0, y: 243 }, 13, "u4"),
  icPower("vcc", "VCC", { x: 105, y: 0 }, 14),
];

function quadGateIc(type: string, label: string, family: string, gateType: string, description: string): ComponentDefinition {
  return {
    type,
    label,
    shortLabel: type.toUpperCase(),
    category: "Logic IC",
    family,
    description,
    width: 210,
    height: 292,
    pins: quadGatePins(),
    units: quadGateUnits(gateType),
  };
}

const hexInverterUnits = (): CircuitUnitDefinition[] => [1, 2, 3, 4, 5, 6].map((index) => ({
  id: `u${index}`,
  label: `${index}/6`,
  kind: "gate" as const,
  gateType: "not",
  inputPinIds: [`${index}i`],
  outputPinIds: [`${index}o`],
}));

const hexInverterPins = (): CircuitPin[] => {
  const pinNumbers: Record<number, [number, number]> = { 1: [1, 2], 2: [3, 4], 3: [5, 6], 4: [9, 8], 5: [11, 10], 6: [13, 12] };
  const centers = [50, 90, 130, 170, 210, 250];
  const pins: CircuitPin[] = centers.flatMap((centerY, index) => {
    const unit = index + 1;
    const [inputNumber, outputNumber] = pinNumbers[unit];
    return [
      unitInput(`${unit}i`, `${unit}A`, { x: 0, y: centerY }, inputNumber, `u${unit}`),
      unitOutput(`${unit}o`, `${unit}Y`, { x: 210, y: centerY }, outputNumber, `u${unit}`),
    ];
  });

  return [
    icPower("gnd", "GND", { x: 105, y: 300 }, 7),
    icPower("vcc", "VCC", { x: 105, y: 0 }, 14),
    ...pins,
  ];
};

function hexInverterIc(type: string, label: string, family: string, description: string): ComponentDefinition {
  return {
    type,
    label,
    shortLabel: type.toUpperCase(),
    category: "Logic IC",
    family,
    description,
    width: 210,
    height: 300,
    pins: hexInverterPins(),
    units: hexInverterUnits(),
  };
}

const tripleNandUnits = (): CircuitUnitDefinition[] => [
  { id: "u1", label: "1/3", kind: "gate", gateType: "nand", inputPinIds: ["1a", "1b", "1c"], outputPinIds: ["1y"] },
  { id: "u2", label: "2/3", kind: "gate", gateType: "nand", inputPinIds: ["2a", "2b", "2c"], outputPinIds: ["2y"] },
  { id: "u3", label: "3/3", kind: "gate", gateType: "nand", inputPinIds: ["3a", "3b", "3c"], outputPinIds: ["3y"] },
];

const tripleNandPins = (): CircuitPin[] => [
  unitInput("1a", "1A", { x: 0, y: 47 }, 1, "u1"),
  unitInput("1b", "1B", { x: 0, y: 67 }, 2, "u1"),
  unitInput("1c", "1C", { x: 0, y: 87 }, 13, "u1"),
  unitOutput("1y", "1Y", { x: 210, y: 67 }, 12, "u1"),
  unitInput("2a", "2A", { x: 0, y: 121 }, 3, "u2"),
  unitInput("2b", "2B", { x: 0, y: 141 }, 4, "u2"),
  unitInput("2c", "2C", { x: 0, y: 161 }, 5, "u2"),
  unitOutput("2y", "2Y", { x: 210, y: 141 }, 6, "u2"),
  icPower("gnd", "GND", { x: 105, y: 282 }, 7),
  unitOutput("3y", "3Y", { x: 210, y: 215 }, 8, "u3"),
  unitInput("3a", "3A", { x: 0, y: 195 }, 9, "u3"),
  unitInput("3b", "3B", { x: 0, y: 215 }, 10, "u3"),
  unitInput("3c", "3C", { x: 0, y: 235 }, 11, "u3"),
  icPower("vcc", "VCC", { x: 105, y: 0 }, 14),
];

const dualDffUnits = (): CircuitUnitDefinition[] => [
  { id: "u1", label: "1/2", kind: "dff", inputPinIds: ["1d"], outputPinIds: ["1q", "1qb"], clockPinIds: ["1cp"], setPinIds: ["1sd"], clearPinIds: ["1rd"], setActiveLevel: "0", clearActiveLevel: "0", edge: "rising", stateWidth: 1 },
  { id: "u2", label: "2/2", kind: "dff", inputPinIds: ["2d"], outputPinIds: ["2q", "2qb"], clockPinIds: ["2cp"], setPinIds: ["2sd"], clearPinIds: ["2rd"], setActiveLevel: "0", clearActiveLevel: "0", edge: "rising", stateWidth: 1 },
];

const dualDffPins = (): CircuitPin[] => [
  unitInput("1rd", "1RD", { x: 0, y: 48 }, 1, "u1"),
  unitInput("1d", "1D", { x: 0, y: 68 }, 2, "u1"),
  unitInput("1cp", "1CP", { x: 0, y: 88 }, 3, "u1"),
  unitInput("1sd", "1SD", { x: 0, y: 108 }, 4, "u1"),
  unitOutput("1q", "1Q", { x: 210, y: 70 }, 5, "u1"),
  unitOutput("1qb", "1Q", { x: 210, y: 90 }, 6, "u1"),
  icPower("gnd", "GND", { x: 105, y: 252 }, 7),
  unitOutput("2qb", "2Q", { x: 210, y: 166 }, 8, "u2"),
  unitOutput("2q", "2Q", { x: 210, y: 186 }, 9, "u2"),
  unitInput("2sd", "2SD", { x: 0, y: 144 }, 10, "u2"),
  unitInput("2cp", "2CP", { x: 0, y: 164 }, 11, "u2"),
  unitInput("2d", "2D", { x: 0, y: 184 }, 12, "u2"),
  unitInput("2rd", "2RD", { x: 0, y: 204 }, 13, "u2"),
  icPower("vcc", "VCC", { x: 105, y: 0 }, 14),
];

const dualCounterUnits = (): CircuitUnitDefinition[] => [
  { id: "u1", label: "1/2", kind: "counter4", inputPinIds: [], outputPinIds: ["1q0", "1q1", "1q2", "1q3"], clockPinIds: ["1cp"], clearPinIds: ["1mr"], clearActiveLevel: "1", edge: "falling", stateWidth: 4 },
  { id: "u2", label: "2/2", kind: "counter4", inputPinIds: [], outputPinIds: ["2q0", "2q1", "2q2", "2q3"], clockPinIds: ["2cp"], clearPinIds: ["2mr"], clearActiveLevel: "1", edge: "falling", stateWidth: 4 },
];

const dualCounterPins = (): CircuitPin[] => [
  unitInput("1cp", "1CP", { x: 0, y: 66 }, 1, "u1"),
  unitInput("1mr", "1MR", { x: 0, y: 90 }, 2, "u1"),
  unitOutput("1q0", "1Q0", { x: 210, y: 54 }, 3, "u1"),
  unitOutput("1q1", "1Q1", { x: 210, y: 78 }, 4, "u1"),
  unitOutput("1q2", "1Q2", { x: 210, y: 102 }, 5, "u1"),
  unitOutput("1q3", "1Q3", { x: 210, y: 126 }, 6, "u1"),
  icPower("gnd", "GND", { x: 105, y: 252 }, 7),
  unitOutput("2q3", "2Q3", { x: 210, y: 150 }, 8, "u2"),
  unitOutput("2q2", "2Q2", { x: 210, y: 174 }, 9, "u2"),
  unitOutput("2q1", "2Q1", { x: 210, y: 198 }, 10, "u2"),
  unitOutput("2q0", "2Q0", { x: 210, y: 222 }, 11, "u2"),
  unitInput("2mr", "2MR", { x: 0, y: 186 }, 12, "u2"),
  unitInput("2cp", "2CP", { x: 0, y: 210 }, 13, "u2"),
  icPower("vcc", "VCC", { x: 105, y: 0 }, 14),
];

const bcdDecoderUnits = (): CircuitUnitDefinition[] => [
  { id: "u1", label: "BCD → 7-seg", kind: "bcd7seg", inputPinIds: ["a", "b", "c", "d"], outputPinIds: ["a_out", "b_out", "c_out", "d_out", "e", "f", "g", "rbo"], clockPinIds: [], setPinIds: [], clearPinIds: [] },
];

const bcdDecoderPins = (): CircuitPin[] => [
  unitInput("b", "B", { x: 0, y: 44 }, 1, "u1"),
  unitInput("c", "C", { x: 0, y: 74 }, 2, "u1"),
  unitInput("lt", "LT", { x: 0, y: 104 }, 3, "u1"),
  unitOutput("rbo", "RBO", { x: 210, y: 36 }, 4, "u1"),
  unitInput("rbi", "RBI", { x: 0, y: 134 }, 5, "u1"),
  unitInput("d", "D", { x: 0, y: 164 }, 6, "u1"),
  unitInput("a", "A", { x: 0, y: 194 }, 7, "u1"),
  icPower("gnd", "GND", { x: 105, y: 250 }, 8),
  unitOutput("e", "e", { x: 210, y: 62 }, 9, "u1"),
  unitOutput("d_out", "d", { x: 210, y: 88 }, 10, "u1"),
  unitOutput("c_out", "c", { x: 210, y: 114 }, 11, "u1"),
  unitOutput("b_out", "b", { x: 210, y: 140 }, 12, "u1"),
  unitOutput("a_out", "a", { x: 210, y: 166 }, 13, "u1"),
  unitOutput("g", "g", { x: 210, y: 192 }, 14, "u1"),
  unitOutput("f", "f", { x: 210, y: 218 }, 15, "u1"),
  icPower("vcc", "VCC", { x: 105, y: 0 }, 16),
];

const sevenSegmentPins = (): CircuitPin[] => ["a", "b", "c", "d", "e", "f", "g", "dp"].map((segment, index) => ({
  id: segment,
  name: segment.toUpperCase(),
  number: index + 1,
  direction: "input" as const,
  offset: { x: 0, y: 34 + index * 24 },
}));

export const componentDefinitions: Record<string, ComponentDefinition> = {
  switch: {
    type: "switch",
    label: "Input switch",
    category: "Digital input",
    description: "A user-controlled logic source.",
    width: 92,
    height: 62,
    defaultValue: "0",
    pins: [outputPin("out", "OUT", { x: 92, y: 31 }, 1)],
  },
  clock: {
    type: "clock",
    label: "Clock",
    category: "Digital input",
    description: "A deterministic clock source for the trainer workspace.",
    width: 92,
    height: 62,
    defaultValue: "0",
    pins: [outputPin("out", "CLK", { x: 92, y: 31 }, 1)],
  },
  and: {
    type: "and",
    label: "AND gate",
    category: "Logic gates",
    description: "Outputs 1 only when both inputs are 1.",
    width: 116,
    height: 78,
    pins: [
      inputPin("a", "A", { x: 0, y: 25 }, 1),
      inputPin("b", "B", { x: 0, y: 53 }, 2),
      outputPin("out", "Y", { x: 116, y: 39 }, 3),
    ],
  },
  or: {
    type: "or",
    label: "OR gate",
    category: "Logic gates",
    description: "Outputs 1 when at least one input is 1.",
    width: 116,
    height: 78,
    pins: [
      inputPin("a", "A", { x: 0, y: 25 }, 1),
      inputPin("b", "B", { x: 0, y: 53 }, 2),
      outputPin("out", "Y", { x: 116, y: 39 }, 3),
    ],
  },
  not: {
    type: "not",
    label: "NOT gate",
    category: "Logic gates",
    description: "Inverts a single logic input.",
    width: 108,
    height: 68,
    pins: [
      inputPin("in", "A", { x: 0, y: 34 }, 1),
      outputPin("out", "Y", { x: 108, y: 34 }, 2),
    ],
  },
  buffer: {
    type: "buffer",
    label: "Buffer",
    category: "Logic gates",
    description: "Drives its input straight through, adding no inversion.",
    width: 108,
    height: 68,
    pins: [
      inputPin("in", "A", { x: 0, y: 34 }, 1),
      outputPin("out", "Y", { x: 108, y: 34 }, 2),
    ],
  },
  nand: {
    type: "nand",
    label: "NAND gate",
    category: "Logic gates",
    description: "Inverts the result of an AND gate.",
    width: 116,
    height: 78,
    pins: [
      inputPin("a", "A", { x: 0, y: 25 }, 1),
      inputPin("b", "B", { x: 0, y: 53 }, 2),
      outputPin("out", "Y", { x: 116, y: 39 }, 3),
    ],
  },
  nor: {
    type: "nor",
    label: "NOR gate",
    category: "Logic gates",
    description: "Inverts the result of an OR gate.",
    width: 116,
    height: 78,
    pins: [
      inputPin("a", "A", { x: 0, y: 25 }, 1),
      inputPin("b", "B", { x: 0, y: 53 }, 2),
      outputPin("out", "Y", { x: 116, y: 39 }, 3),
    ],
  },
  xor: {
    type: "xor",
    label: "XOR gate",
    category: "Logic gates",
    description: "Outputs 1 when the inputs are different.",
    width: 116,
    height: 78,
    pins: [
      inputPin("a", "A", { x: 0, y: 25 }, 1),
      inputPin("b", "B", { x: 0, y: 53 }, 2),
      outputPin("out", "Y", { x: 116, y: 39 }, 3),
    ],
  },
  xnor: {
    type: "xnor",
    label: "XNOR gate",
    category: "Logic gates",
    description: "Outputs 1 when the inputs are equal.",
    width: 116,
    height: 78,
    pins: [
      inputPin("a", "A", { x: 0, y: 25 }, 1),
      inputPin("b", "B", { x: 0, y: 53 }, 2),
      outputPin("out", "Y", { x: 116, y: 39 }, 3),
    ],
  },
  led: {
    type: "led",
    label: "LED",
    category: "Digital output",
    description: "Displays the logic value connected to its input.",
    width: 92,
    height: 62,
    pins: [inputPin("in", "A", { x: 0, y: 31 }, 1)],
  },
  probe: {
    type: "probe",
    label: "Logic probe",
    category: "Digital output",
    description: "Reads a node and shows its live logic level (0, 1 or X).",
    width: 96,
    height: 62,
    pins: [inputPin("in", "A", { x: 0, y: 31 }, 1)],
  },
  vcc: {
    type: "vcc",
    label: "+5 V supply",
    category: "Power",
    description: "A constant high logic source.",
    width: 92,
    height: 62,
    defaultValue: "1",
    pins: [powerPin("vcc", "VCC", { x: 92, y: 31 }, 1, "output")],
  },
  gnd: {
    type: "gnd",
    label: "Ground",
    category: "Power",
    description: "A constant low logic source.",
    width: 92,
    height: 62,
    defaultValue: "0",
    pins: [powerPin("gnd", "GND", { x: 92, y: 31 }, 1, "output")],
  },
  "7400": quadGateIc("7400", "7400 Quad 2-input NAND", "TTL", "nand", "Classic TTL quad 2-input NAND gate. Units 1/4 to 4/4 in a 14-pin DIP."),
  "74ls00": quadGateIc("74ls00", "74LS00 Quad 2-input NAND", "LS TTL", "nand", "Low-power Schottky quad 2-input NAND gate, DIP-14."),
  "4011": quadGateIc("4011", "CD4011 Quad 2-input NAND", "CMOS", "nand", "CMOS quad 2-input NAND gate, DIP-14, pin-compatible with the 7400."),
  "74ls08": quadGateIc("74ls08", "74LS08 Quad 2-input AND", "LS TTL", "and", "Low-power Schottky quad 2-input AND gate, DIP-14."),
  "4081": quadGateIc("4081", "CD4081 Quad 2-input AND", "CMOS", "and", "CMOS quad 2-input AND gate, DIP-14."),
  "74ls32": quadGateIc("74ls32", "74LS32 Quad 2-input OR", "LS TTL", "or", "Low-power Schottky quad 2-input OR gate, DIP-14."),
  "4071": quadGateIc("4071", "CD4071 Quad 2-input OR", "CMOS", "or", "CMOS quad 2-input OR gate, DIP-14."),
  "74ls86": quadGateIc("74ls86", "74LS86 Quad 2-input XOR", "LS TTL", "xor", "Low-power Schottky quad 2-input XOR gate, DIP-14."),
  "4030": quadGateIc("4030", "CD4030 Quad 2-input XOR", "CMOS", "xor", "CMOS quad 2-input XOR gate, DIP-14."),
  "74ls04": hexInverterIc("74ls04", "74LS04 Hex inverter", "LS TTL", "Six independent inverters, DIP-14."),
  "74ls14": hexInverterIc("74ls14", "74LS14 Hex Schmitt inverter", "LS TTL", "Six independent Schmitt-trigger inverters, DIP-14."),
  "74ls10": {
    type: "74ls10",
    label: "74LS10 Triple 3-input NAND",
    shortLabel: "74LS10",
    category: "Logic IC",
    family: "LS TTL",
    description: "Three independent 3-input NAND gates, DIP-14.",
    width: 210,
    height: 282,
    pins: tripleNandPins(),
    units: tripleNandUnits(),
  },
  "74ls74": {
    type: "74ls74",
    label: "74LS74 Dual D flip-flop",
    shortLabel: "74LS74",
    category: "Sequential IC",
    family: "LS TTL",
    description: "Two positive-edge-triggered D flip-flops with preset, clear and complementary outputs, DIP-14.",
    width: 210,
    height: 252,
    pins: dualDffPins(),
    units: dualDffUnits(),
  },
  "74ls393": {
    type: "74ls393",
    label: "74LS393 Dual 4-bit counter",
    shortLabel: "74LS393",
    category: "Sequential IC",
    family: "LS TTL",
    description: "Two independent 4-bit binary ripple counters with asynchronous master reset, DIP-14. Each half counts on the falling clock edge.",
    width: 210,
    height: 252,
    pins: dualCounterPins(),
    units: dualCounterUnits(),
  },
  "7447": {
    type: "7447",
    label: "7447 BCD to 7-segment decoder",
    shortLabel: "7447",
    category: "Display IC",
    family: "TTL",
    description: "BCD to 7-segment decoder/driver with open-collector active-low outputs, lamp test and ripple blanking, DIP-16. Drives a common-anode display. BCD codes above 9 blank the display.",
    width: 210,
    height: 250,
    pins: bcdDecoderPins(),
    units: bcdDecoderUnits(),
  },
  display7: {
    type: "display7",
    label: "7-segment display",
    shortLabel: "7-SEG",
    category: "Digital output",
    description: "Eight-segment display (a-g plus decimal point). Common cathode lights on HIGH, common anode lights on LOW.",
    width: 120,
    height: 230,
    pins: sevenSegmentPins(),
    parameters: { anode: "cathode" },
  },
};

function createId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createCircuitComponent(type: string, position: { x: number; y: number }, id = createId(type)): CircuitComponent {
  const definition = componentDefinitions[type];

  if (!definition) {
    throw new Error(`Unknown circuit component: ${type}`);
  }

  return {
    id,
    type,
    label: definition.label,
    category: definition.category,
    position,
    rotation: 0,
    value: definition.defaultValue,
    pins: definition.pins.map((pin) => ({ ...pin, offset: { ...(pin.offset ?? { x: 0, y: 0 }) } })),
    parameters: definition.parameters ? { ...definition.parameters } : undefined,
  };
}

export function getComponentUnits(type: string): CircuitUnitDefinition[] {
  return getComponentDefinition(type)?.units ?? [];
}

export function unitStateKey(componentId: string, unitId: string): string {
  return `${componentId}:${unitId}`;
}

export function getComponentDefinition(type: string): ComponentDefinition | undefined {
  return componentDefinitions[type];
}

export function pinNodeId(componentId: string, pinId: string): string {
  return `${componentId}:${pinId}`;
}
