import { describe, expect, it } from "vitest";
import { experimentDefinitions, findExperiment } from "../src/lib/experiments";

function evaluate(id: string, source: string) {
  return findExperiment(id).evaluate(source);
}

const solutions: Record<string, string> = {
  "x86-loop-sum": [
    "        MOV AX, 0",
    "        MOV CX, 1",
    "LOOP_START:",
    "        CMP CX, 5",
    "        JG  DONE",
    "        ADD AX, CX",
    "        INC CX",
    "        JMP LOOP_START",
    "DONE:",
    "        HLT",
    "",
  ].join("\n"),
  "x86-store-memory": [
    "        MOV AX, 42",
    "        MOV [202h], AX",
    "        HLT",
    "",
  ].join("\n"),
  "mcu-count": [
    "        MOV R0, #0",
    "LOOP:   INC R0",
    "        CJNE R0, #10, LOOP",
    "HERE:   SJMP HERE",
    "",
  ].join("\n"),
  "mcu-store-ram": [
    "        MOV A, #2Ah",
    "        MOV 30h, A",
    "HERE:   SJMP HERE",
    "",
  ].join("\n"),
  "mcu-serial": [
    "        MOV SBUF, #48h",
    "        MOV SBUF, #69h",
    "HERE:   SJMP HERE",
    "",
  ].join("\n"),
};

describe("experiment catalog", () => {
  it("exposes unique definitions across both engines", () => {
    const ids = experimentDefinitions.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(experimentDefinitions.map((definition) => definition.engine))).toEqual(new Set(["x86", "mcu8051"]));
  });

  it("ships a starter for every experiment that assembles but fails its checks", () => {
    for (const definition of experimentDefinitions) {
      const evaluation = definition.evaluate(definition.starter);
      expect(evaluation.compiled, `${definition.id} starter must assemble`).toBe(true);
      expect(evaluation.checks.some((check) => !check.passed), `${definition.id} starter must not pass`).toBe(true);
    }
  });

  it("accepts a correct solution for every experiment", () => {
    for (const definition of experimentDefinitions) {
      const evaluation = definition.evaluate(solutions[definition.id]);
      expect(evaluation.compiled, `${definition.id} solution must assemble`).toBe(true);
      expect(evaluation.checks.every((check) => check.passed), `${definition.id} solution must pass all checks`).toBe(true);
      expect(evaluation.evidence.length).toBeGreaterThan(0);
    }
  });

  it("reports an assembly error instead of throwing", () => {
    const evaluation = evaluate("x86-loop-sum", "BOGUS OPCODE HERE");
    expect(evaluation.compiled).toBe(false);
    expect(evaluation.error).toBeTruthy();
    expect(evaluation.checks).toEqual([]);
  });
});
