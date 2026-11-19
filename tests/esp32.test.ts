import { describe, expect, it } from "vitest";
import { assemble } from "../src/lib/esp32/assembler";
import { createMachine, runMachine } from "../src/lib/esp32/simulator";
import { esp32Mmu } from "../src/lib/esp32/types";

function word(bytes: number[], index = 0): number {
  const base = index * 4;
  return (bytes[base] | (bytes[base + 1] << 8) | (bytes[base + 2] << 16) | (bytes[base + 3] << 24)) >>> 0;
}

function run(source: string): ReturnType<typeof runMachine> {
  return runMachine(createMachine(assemble(source)), { stepLimit: 50000 });
}

describe("ESP32 RV32I assembler", () => {
  it("encodes addi as little-endian bytes", () => {
    const assembly = assemble("    addi x1, x0, 5");
    expect(assembly.bytes).toEqual([0x93, 0x00, 0x50, 0x00]);
  });

  it("encodes an R-type add", () => {
    expect(word(assemble("    add x1, x2, x3").bytes)).toBe(0x003100b3);
  });

  it("encodes lui with a 20-bit upper immediate", () => {
    expect(word(assemble("    lui x5, 0x12345").bytes)).toBe(0x123452b7);
  });

  it("splits a large li into lui + addi", () => {
    const assembly = assemble("    li x5, 0x12345");
    expect(assembly.bytes).toHaveLength(8);
    expect(word(assembly.bytes, 0) & 0x7f).toBe(0x37);
    expect(word(assembly.bytes, 1) & 0x7f).toBe(0x13);
  });

  it("sizes binary and negative immediates consistently", () => {
    expect(assemble("    li x5, 0b1000000000000").bytes).toHaveLength(8);
    expect(assemble("    li x5, 0x1").bytes).toHaveLength(4);
    expect(assemble("    li x5, -0x800").bytes).toHaveLength(4);
    expect(assemble("    li x5, -0x8000").bytes).toHaveLength(8);
  });

  it("rejects a label operand in li with a clear diagnostic", () => {
    const assembly = assemble("    li x5, here\nhere:\n    nop");
    expect(assembly.diagnostics.some((d) => d.severity === "error" && d.message.includes("li requires a numeric"))).toBe(true);
  });

  it("reports unknown instructions and duplicate labels", () => {
    const unknown = assemble("    frobnicate x1, x2");
    expect(unknown.diagnostics.some((d) => d.severity === "error" && d.message.includes("frobnicate"))).toBe(true);

    const duplicate = assemble("start:\n    nop\nstart:\n    nop");
    expect(duplicate.diagnostics.some((d) => d.severity === "error" && d.message.includes("Duplicate"))).toBe(true);
  });
});

describe("ESP32 RV32I simulator", () => {
  it("sums 1 to 10 in a0 and halts", () => {
    const result = run("    li a0, 0\n    li a1, 1\n    li a2, 11\nloop:\n    add a0, a0, a1\n    addi a1, a1, 1\n    blt a1, a2, loop\n    ebreak");
    expect(result.haltReason).toBe("halted");
    expect(result.finalState.registers[10]).toBe(55);
  });

  it("walks a lit bit across the GPIO output latch", () => {
    const result = run("    li a1, 0x60004000\n    li a2, 1\n    li a4, 8\nloop:\n    sw a2, 4(a1)\n    slli a2, a2, 1\n    addi a4, a4, -1\n    bne a4, x0, loop\n    ebreak");
    expect(result.haltReason).toBe("halted");
    const seen = new Set(result.trace.map((step) => step.gpio & 0xff));
    expect(seen.size).toBeGreaterThan(1);
    expect(result.finalState.gpioOut & 0xff).toBe(0x80);
  });

  it("prints a greeting to the UART console", () => {
    const result = run("    li a1, 0x60000000\n    li a2, 0x48\n    sb a2, 0(a1)\n    li a2, 0x69\n    sb a2, 0(a1)\n    li a2, 0x0A\n    sb a2, 0(a1)\n    ebreak");
    expect(result.console.join("")).toBe("Hi\n");
  });

  it("round-trips a value through data memory", () => {
    const result = run("    li a1, 0x40\n    li a2, 0x5a\n    sw a2, 0(a1)\n    lw a0, 0(a1)\n    ebreak");
    expect(result.haltReason).toBe("halted");
    expect(result.finalState.registers[10]).toBe(0x5a);
  });

  it("reads GPIO input through lbu", () => {
    const machine = createMachine(assemble("    li a1, 0x6000403c\n    lbu a0, 0(a1)\n    ebreak"));
    machine.state.gpioIn = 0x5a;
    const result = runMachine(machine);
    expect(result.finalState.registers[10]).toBe(0x5a);
  });

  it("reports a step limit for an unbounded loop", () => {
    const result = run("loop:\n    nop\n    j loop");
    expect(result.haltReason).toBe("step-limit");
  });

  it("writes the GPIO output register through the peripheral window", () => {
    expect(esp32Mmu.gpioOut).toBe(0x60004004);
    const result = run("    li a1, 0x60004000\n    li a2, 0xaa\n    sw a2, 4(a1)\n    ebreak");
    expect(result.finalState.gpioOut & 0xff).toBe(0xaa);
  });
});
