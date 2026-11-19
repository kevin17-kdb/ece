import { runX8051 } from "./mcu8051/simulator";
import { sfrAddress } from "./mcu8051/types";
import type { X8051RunResult } from "./mcu8051/types";
import { simulateX86 } from "./x86/simulator";
import type { X86RunResult } from "./x86/types";

export type ExperimentEngine = "x86" | "mcu8051";

export interface ExperimentCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ExperimentEvaluation {
  compiled: boolean;
  error?: string;
  checks: ExperimentCheck[];
  evidence: string[];
}

export interface ExperimentDefinition {
  id: string;
  engine: ExperimentEngine;
  title: string;
  difficulty: "intro" | "core" | "advanced";
  summary: string;
  objectives: string[];
  steps: string[];
  hint: string;
  starter: string;
  evaluate: (source: string) => ExperimentEvaluation;
}

function hex(value: number, width = 2): string {
  return (value & 0xffff).toString(16).toUpperCase().padStart(width, "0");
}

function evaluateX86(
  source: string,
  build: (result: X86RunResult) => ExperimentCheck[],
  evidence: (result: X86RunResult) => string[],
): ExperimentEvaluation {
  try {
    const result = simulateX86({ source, maxSteps: 20000 });
    if (result.haltReason === "error") {
      return { compiled: false, error: result.error?.message ?? "Assembly failed", checks: [], evidence: [] };
    }

    return { compiled: true, checks: build(result), evidence: evidence(result) };
  } catch (error) {
    return { compiled: false, error: error instanceof Error ? error.message : String(error), checks: [], evidence: [] };
  }
}

function evaluateMcu(
  source: string,
  build: (result: X8051RunResult) => ExperimentCheck[],
  evidence: (result: X8051RunResult) => string[],
): ExperimentEvaluation {
  try {
    const result = runX8051(source, { stepLimit: 50000 });
    if (result.haltReason === "error") {
      return { compiled: false, error: result.error ?? "Assembly failed", checks: [], evidence: [] };
    }

    return { compiled: true, checks: build(result), evidence: evidence(result) };
  } catch (error) {
    return { compiled: false, error: error instanceof Error ? error.message : String(error), checks: [], evidence: [] };
  }
}

function x86Evidence(result: X86RunResult): string[] {
  const registers = result.finalRegisters;
  return [
    `AX=${hex(registers.ax)}h BX=${hex(registers.bx)}h CX=${hex(registers.cx)}h DX=${hex(registers.dx)}h`,
    `halt: ${result.haltReason} · ${result.steps} instructions`,
  ];
}

function mcuEvidence(result: X8051RunResult): string[] {
  const state = result.finalState;
  const registers = Array.from({ length: 8 }, (_, index) => `R${index}=${hex(state.iram[index])}h`).join(" ");
  return [
    `A=${hex(state.sfr[sfrAddress.acc - 0x80])}h PC=${hex(state.pc)}h`,
    registers,
    `halt: ${result.haltReason} · ${result.steps} instructions`,
  ];
}

export const experimentDefinitions: ExperimentDefinition[] = [
  {
    id: "x86-loop-sum",
    engine: "x86",
    title: "Sum 1 to 5 with a loop",
    difficulty: "core",
    summary: "Accumulate the integers 1 through 5 in AX using a counted 8086 loop.",
    objectives: [
      "Use a register as an accumulator starting at 0.",
      "Add the loop counter to the accumulator each pass.",
      "Stop after the value 5 has been added.",
    ],
    steps: [
      "Set AX (the accumulator) and CX (the counter) to sensible start values.",
      "Inside the loop, add CX to AX before advancing the counter.",
      "Branch back until CX has passed 5, then halt with HLT.",
    ],
    hint: "Increment the counter first, then compare against 5 with CMP, or compare before incrementing. The loop must run exactly five times.",
    starter: [
      "; Objective: at HLT, AX must equal 15 (1+2+3+4+5).",
      "; The loop body is incomplete - finish it so the sum accumulates.",
      "",
      "        MOV AX, 0        ; accumulator",
      "        MOV CX, 1        ; counter",
      "LOOP_START:",
      "        CMP CX, 5",
      "        JG  DONE",
      "        ; TODO: add CX to AX",
      "        INC CX",
      "        JMP LOOP_START",
      "DONE:",
      "        HLT",
      "",
    ].join("\n"),
    evaluate: (source) => evaluateX86(source, (result) => [
      {
        id: "halted",
        label: "Program reaches HLT instead of running away",
        passed: result.haltReason === "halted" || result.haltReason === "terminated",
        detail: `halt reason is "${result.haltReason}"`,
      },
      {
        id: "sum",
        label: "AX holds the sum 15",
        passed: result.finalRegisters.ax === 15,
        detail: `AX = ${result.finalRegisters.ax}`,
      },
    ], x86Evidence),
  },
  {
    id: "x86-store-memory",
    engine: "x86",
    title: "Store a value in memory",
    difficulty: "intro",
    summary: "Load the decimal value 42 into a register and store it at memory address 0202h.",
    objectives: ["Write a word to a direct memory address", "Place the value 42 (2Ah) at 0202h"],
    steps: [
      "Load 42 into a 16-bit register.",
      "Store the register to the direct address 0202h using square-bracket addressing.",
      "Halting with HLT lets the check read the final write.",
    ],
    hint: "MOV AX, 42 loads the value; MOV [202h], AX stores the word at that address.",
    starter: [
      "; Objective: the word 42 (2Ah) must be written to memory address 0202h.",
      "        MOV AX, 0        ; TODO: load the decimal value 42",
      "        MOV [202h], AX",
      "        HLT",
      "",
    ].join("\n"),
    evaluate: (source) => evaluateX86(source, (result) => {
      const write = result.accesses.filter((access) => access.mode !== "read" && access.address === 0x202).pop();
      return [
        {
          id: "written",
          label: "Address 0202h is written",
          passed: Boolean(write),
          detail: write ? "a write to 0202h was recorded" : "no write to 0202h was recorded",
        },
        {
          id: "value",
          label: "The stored word equals 42 (2Ah)",
          passed: write?.value === 0x2a,
          detail: write ? `stored value = ${hex(write.value, 4)}h` : "nothing stored",
        },
      ];
    }, x86Evidence),
  },
  {
    id: "mcu-count",
    engine: "mcu8051",
    title: "Count to ten in R0",
    difficulty: "intro",
    summary: "Use a compare-and-jump loop so that register R0 ends at 10 when the program halts.",
    objectives: ["Use INC on a register", "Stop the loop with CJNE at the goal value"],
    steps: [
      "Start R0 at zero.",
      "Increment R0 each pass and loop back with CJNE while it is below the target.",
      "When the target is reached, fall through to a self-loop so the CPU halts.",
    ],
    hint: "CJNE R0, #10, LOOP jumps back whenever R0 is not yet 10; when R0 equals 10 it falls through to the halt.",
    starter: [
      "; Objective: R0 must hold 10 when the program halts.",
      "        MOV R0, #0",
      "LOOP:   INC R0",
      "        CJNE R0, #7, LOOP   ; TODO: stop at 10, not 7",
      "HERE:   SJMP HERE",
      "",
    ].join("\n"),
    evaluate: (source) => evaluateMcu(source, (result) => [
      {
        id: "halted",
        label: "Program halts at the self-loop",
        passed: result.haltReason === "halted",
        detail: `halt reason is "${result.haltReason}"`,
      },
      {
        id: "r0",
        label: "R0 holds ten",
        passed: result.finalState.iram[0] === 10,
        detail: `R0 = ${result.finalState.iram[0]}`,
      },
    ], mcuEvidence),
  },
  {
    id: "mcu-store-ram",
    engine: "mcu8051",
    title: "Store a constant in internal RAM",
    difficulty: "core",
    summary: "Put 42 (2Ah) into internal RAM location 30h using the accumulator.",
    objectives: ["Load an immediate into the accumulator", "Move the accumulator to a direct RAM address"],
    steps: [
      "Load the immediate 2Ah into A.",
      "Move A to the direct address 30h.",
      "The self-loop halts the CPU so the checker can read RAM.",
    ],
    hint: "MOV A, #2Ah loads the value and MOV 30h, A copies it into RAM.",
    starter: [
      "; Objective: internal RAM address 30h must hold 42 (2Ah) at halt.",
      "        MOV A, #0        ; TODO: load 2Ah into A",
      "        MOV 30h, A",
      "HERE:   SJMP HERE",
      "",
    ].join("\n"),
    evaluate: (source) => evaluateMcu(source, (result) => [
      {
        id: "halted",
        label: "Program halts at the self-loop",
        passed: result.haltReason === "halted",
        detail: `halt reason is "${result.haltReason}"`,
      },
      {
        id: "ram",
        label: "RAM[30h] equals 2Ah",
        passed: result.finalState.iram[0x30] === 0x2a,
        detail: `RAM[30h] = ${hex(result.finalState.iram[0x30])}h`,
      },
    ], mcuEvidence),
  },
  {
    id: "mcu-serial",
    engine: "mcu8051",
    title: "Send a serial greeting",
    difficulty: "advanced",
    summary: "Write the characters H and i to SBUF so the serial console prints \"Hi\".",
    objectives: ["Send an immediate ASCII code to SBUF", "Send a second character after the first"],
    steps: [
      "Move 48h ('H') into SBUF.",
      "Move 69h ('i') into SBUF.",
      "Halting leaves both characters in the console.",
    ],
    hint: "SBUF is an SFR: MOV SBUF, #48h then MOV SBUF, #69h. Each write is captured as a character.",
    starter: [
      "; Objective: print the characters H then i to the serial console.",
      "        MOV SBUF, #0     ; TODO: H is 48h",
      "        MOV SBUF, #0     ; TODO: i is 69h",
      "HERE:   SJMP HERE",
      "",
    ].join("\n"),
    evaluate: (source) => evaluateMcu(source, (result) => [
      {
        id: "halted",
        label: "Program halts at the self-loop",
        passed: result.haltReason === "halted",
        detail: `halt reason is "${result.haltReason}"`,
      },
      {
        id: "console",
        label: "Console prints \"Hi\"",
        passed: result.console.join("") === "Hi",
        detail: `console = ${JSON.stringify(result.console.join(""))}`,
      },
    ], mcuEvidence),
  },
];

export const defaultExperiment = experimentDefinitions[0];

export function findExperiment(id: string): ExperimentDefinition {
  return experimentDefinitions.find((experiment) => experiment.id === id) ?? experimentDefinitions[0];
}

export function userSourceFor(document: { sources: Record<string, string> } | undefined, definition: ExperimentDefinition): string {
  return document?.sources[definition.id] ?? definition.starter;
}
