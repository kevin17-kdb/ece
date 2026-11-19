import { describe, expect, it } from "vitest";
import { createRegisters, numberToFlags } from "../src/lib/x86/types";
import { evaluateWatch } from "../src/lib/x86/watch";

function setup() {
  const registers = createRegisters();
  registers.ax = 0x1234;
  registers.bx = 0x0010;
  registers.ds = 0x0000;
  registers.flags = numberToFlags(0x0047).cf ? 0x0047 : 0x0047;
  const memory = new Uint8Array(0x10000);
  memory[0x10] = 0xab;
  memory[0x100] = 0x5a;
  memory[0x101] = 0xff;
  return { registers, memory };
}

describe("8086 watch evaluator", () => {
  it("reads word and byte registers", () => {
    const { registers, memory } = setup();

    expect(evaluateWatch("ax", registers, memory).value).toBe(0x1234);
    expect(evaluateWatch("AL", registers, memory).value).toBe(0x34);
    expect(evaluateWatch("ah", registers, memory).value).toBe(0x12);
  });

  it("reads flags as 0/1", () => {
    const { registers, memory } = setup();
    registers.flags = 1;

    expect(evaluateWatch("cf", registers, memory).value).toBe(1);
    expect(evaluateWatch("zf", registers, memory).value).toBe(0);
  });

  it("reads memory via segment:offset and register addressing", () => {
    const { registers, memory } = setup();

    expect(evaluateWatch("[100h]", registers, memory).value).toBe(0x5a);
    expect(evaluateWatch("ds:100h", registers, memory).value).toBe(0x5a);
    expect(evaluateWatch("[bx]", registers, memory).value).toBe(0xab);
    expect(evaluateWatch("[bx+2]", registers, memory).value).toBe(0x00);
  });

  it("supports arithmetic and number literals", () => {
    const { registers, memory } = setup();

    expect(evaluateWatch("ax+10", registers, memory).value).toBe(0x123e);
    expect(evaluateWatch("0x10+10", registers, memory).value).toBe(0x1a);
    expect(evaluateWatch("2ah", registers, memory).value).toBe(0x2a);
  });

  it("reports unknown symbols without throwing", () => {
    const { registers, memory } = setup();
    const result = evaluateWatch("nope", registers, memory);

    expect(result.value).toBeNull();
    expect(result.error).toContain("nope");
  });
});
