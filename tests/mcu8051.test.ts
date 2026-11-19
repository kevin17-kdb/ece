import { describe, expect, it } from "vitest";

import { assemble } from "../src/lib/mcu8051/assembler";
import {
  createMachine,
  runX8051,
  stepMachine,
} from "../src/lib/mcu8051/simulator";

describe("8051 assembler", () => {
  it("assembles basic move and add instructions", () => {
    const assembly = assemble(["MOV A,#10h", "ADD A,#05h", "SJMP $"].join("\n"));
    expect(assembly.bytes.slice(0, 6)).toEqual([0x74, 0x10, 0x24, 0x05, 0x80, 0xfe]);
    expect(assembly.listing).toHaveLength(3);
    expect(assembly.diagnostics[0].severity).toBe("warning");
  });

  it("resolves labels into relative jumps", () => {
    const source = ["LOOP:", "INC A", "CJNE A,#5,LOOP", "SJMP $"].join("\n");
    const assembly = assemble(source);
    const cjne = assembly.listing[1];
    expect(cjne.bytes[0]).toBe(0xb4);
    expect(cjne.bytes[2]).toBe(0xfc);
  });

  it("reports unknown symbols as errors", () => {
    const assembly = assemble("MOV A,NOPE");
    expect(assembly.diagnostics[0].severity).toBe("error");
  });

  it("encodes direct,A logical operations", () => {
    expect(assemble("ANL 20h,A").bytes).toEqual([0x52, 0x20]);
    expect(assemble("ORL 20h,A").bytes).toEqual([0x42, 0x20]);
    expect(assemble("XRL 20h,A").bytes).toEqual([0x62, 0x20]);
    expect(assemble("ANL 20h,#0f0h").bytes).toEqual([0x53, 0x20, 0xf0]);
  });
});

describe("8051 simulator", () => {
  it("adds two immediates and halts on self loop", () => {
    const result = runX8051(["MOV A,#10h", "ADD A,#05h", "SJMP $"].join("\n"));
    expect(result.haltReason).toBe("halted");
    expect(result.finalState.sfr[0xe0 - 0x80]).toBe(0x15);
    expect(result.steps).toBe(3);
  });

  it("stores to internal RAM with directives", () => {
    const result = runX8051(["MOV R0,#30h", "MOV A,#0abh", "MOV @R0,A", "SJMP $"].join("\n"));
    expect(result.finalState.iram[0x30]).toBe(0xab);
  });

  it("writes serial output to the console", () => {
    const result = runX8051(["MOV SBUF,#41h", "MOV SBUF,#42h", "SJMP $"].join("\n"));
    expect(result.console.join("")).toBe("AB");
  });

  it("loops with DJNZ the expected number of times", () => {
    const result = runX8051(["MOV R2,#3", "LOOP:", "INC A", "DJNZ R2,LOOP", "SJMP $"].join("\n"));
    expect(result.finalState.sfr[0xe0 - 0x80]).toBe(3);
    expect(result.finalState.iram[2]).toBe(0);
  });

  it("supports subroutines via ACALL/RET", () => {
    const source = ["LCALL WORK", "SJMP $", "WORK:", "MOV A,#7", "RET"].join("\n");
    const result = runX8051(source);
    expect(result.finalState.sfr[0xe0 - 0x80]).toBe(7);
  });

  it("exposes step tracing with register snapshots", () => {
    const assembly = assemble(["MOV A,#1", "MOV B,#2", "SJMP $"].join("\n"));
    const machine = createMachine(assembly);
    const first = stepMachine(machine, 0);
    expect(first.a).toBe(1);
    expect(first.pc).toBe(0);
    const second = stepMachine(machine, 1);
    expect(second.b).toBe(2);
    expect(second.index).toBe(1);
  });

  it("reports unsupported opcodes as errors", () => {
    const assembly = assemble("SJMP $");
    const machine = createMachine(assembly);
    machine.code[0] = 0xa5;
    expect(() => stepMachine(machine, 0)).toThrow(/Unsupported opcode/);
  });
});
