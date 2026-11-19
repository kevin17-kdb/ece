import { describe, expect, it } from "vitest";
import { assemble } from "../src/lib/x86/assembler";
import { decodeAt } from "../src/lib/x86/decoder";
import { createContext, executeInstruction, X86RuntimeError, type X86Context } from "../src/lib/x86/cpu";
import { createMemory, createNullDevice, simulateX86 } from "../src/lib/x86/simulator";
import { numberToFlags } from "../src/lib/x86/types";

function encode(source: string): number[] {
  const assembly = assemble(source);
  return assembly.bytes.slice(assembly.origin);
}

function run(source: string, options: { maxSteps?: number; device?: { read(port: number): number; write(port: number, value: number): void } } = {}) {
  return simulateX86({ source, maxSteps: options.maxSteps, device: options.device });
}

function contextFor(source: string, setup?: (context: X86Context) => void): X86Context {
  const assembly = assemble(source);
  const memory = createMemory();
  for (let index = 0; index < assembly.bytes.length; index += 1) {
    memory[index] = assembly.bytes[index] & 0xff;
  }

  const context = createContext(memory, createNullDevice(), { entryPoint: assembly.entryPoint });
  setup?.(context);
  return context;
}

function asmError(source: string): { message: string; line: number } | undefined {
  try {
    const assembly = assemble(source);
    const diagnostic = assembly.diagnostics.find((item) => item.severity === "error");
    return diagnostic ? { message: diagnostic.message, line: diagnostic.line } : undefined;
  } catch (cause) {
    return cause as { message: string; line: number };
  }
}

describe("x86 assembler encodings", () => {
  it("encodes the canonical register and immediate forms", () => {
    expect(encode("mov ax, bx")).toEqual([0x89, 0xd8]);
    expect(encode("mov bx, ax")).toEqual([0x89, 0xc3]);
    expect(encode("mov al, 5")).toEqual([0xb0, 0x05]);
    expect(encode("mov ah, 0x12")).toEqual([0xb4, 0x12]);
    expect(encode("mov ax, 1234h")).toEqual([0xb8, 0x34, 0x12]);
    expect(encode("add ax, 1")).toEqual([0x83, 0xc0, 0x01]);
    expect(encode("sub bx, 3")).toEqual([0x83, 0xeb, 0x03]);
    expect(encode("add al, 1")).toEqual([0x04, 0x01]);
    expect(encode("inc ax")).toEqual([0x40]);
    expect(encode("dec bx")).toEqual([0xff, 0xcb]);
    expect(encode("not ax")).toEqual([0xf7, 0xd0]);
    expect(encode("neg ax")).toEqual([0xf7, 0xd8]);
    expect(encode("mul bx")).toEqual([0xf7, 0xe3]);
    expect(encode("div cx")).toEqual([0xf7, 0xf1]);
  });

  it("encodes memory operands with the standard modrm combinations", () => {
    expect(encode("mov ax, [bx]")).toEqual([0x8b, 0x07]);
    expect(encode("mov ax, [bx+si]")).toEqual([0x8b, 0x00]);
    expect(encode("mov ax, [bx+di]")).toEqual([0x8b, 0x01]);
    expect(encode("mov ax, [bp]")).toEqual([0x8b, 0x46, 0x00]);
    expect(encode("mov ax, [bp+si]")).toEqual([0x8b, 0x02]);
    expect(encode("mov ax, [si]")).toEqual([0x8b, 0x04]);
    expect(encode("mov ax, [di]")).toEqual([0x8b, 0x05]);
    expect(encode("mov ax, [bp+4]")).toEqual([0x8b, 0x46, 0x04]);
    expect(encode("mov ax, [bx+2]")).toEqual([0x8b, 0x47, 0x02]);
    expect(encode("mov [bx+si+6], ax")).toEqual([0x89, 0x40, 0x06]);
    expect(encode("mov ax, [100h]")).toEqual([0xa1, 0x00, 0x01]);
    expect(encode("mov byte [200h], al")).toEqual([0xa2, 0x00, 0x02]);
    expect(encode("mov ax, 1")).toEqual([0xb8, 0x01, 0x00]);
  });

  it("encodes stack, transfer, io, string and interrupt forms", () => {
    expect(encode("push ax")).toEqual([0x50]);
    expect(encode("push bp")).toEqual([0x55]);
    expect(encode("pop bx")).toEqual([0x5b]);
    expect(encode("xchg ax, bx")).toEqual([0x93]);
    expect(encode("xchg cx, dx")).toEqual([0x87, 0xca]);
    expect(encode("lea si, [bx+4]")).toEqual([0x8d, 0x77, 0x04]);
    expect(encode("lea di, [bp-2]")).toEqual([0x8d, 0x7e, 0xfe]);
    expect(encode("in al, 10h")).toEqual([0xe4, 0x10]);
    expect(encode("in ax, dx")).toEqual([0xed]);
    expect(encode("out 20h, al")).toEqual([0xe6, 0x20]);
    expect(encode("out dx, ax")).toEqual([0x6f]);
    expect(encode("movsb")).toEqual([0xa4]);
    expect(encode("stosw")).toEqual([0xab]);
    expect(encode("lodsb")).toEqual([0xac]);
    expect(encode("scasb")).toEqual([0xae]);
    expect(encode("cmpsw")).toEqual([0xa7]);
    expect(encode("rep movsb")).toEqual([0xf3, 0xa4]);
    expect(encode("repe cmpsb")).toEqual([0xf3, 0xa6]);
    expect(encode("int 21h")).toEqual([0xcd, 0x21]);
    expect(encode("hlt")).toEqual([0xf4]);
    expect(encode("cbw")).toEqual([0x98]);
    expect(encode("cwd")).toEqual([0x99]);
    expect(encode("cld")).toEqual([0xfc]);
    expect(encode("std")).toEqual([0xfd]);
    expect(encode("es:mov ax, [bx]")).toEqual([0x26, 0x8b, 0x07]);
  });

  it("encodes jumps and calls deterministically as rel16 or rel8", () => {
    const program = [
      "jmp next",
      "nop",
      "next:",
      "call sub_routine",
      "jmp done",
      "sub_routine:",
      "ret",
      "done:",
      "int 20h",
    ].join("\n");

    const bytes = encode(program);
    expect(bytes.slice(0, 3)).toEqual([0xe9, 0x01, 0x00]);
    expect(bytes[3]).toBe(0x90);
    expect(bytes[4]).toBe(0xe8);
    expect(bytes.slice(5, 7)).toEqual([0x03, 0x00]);
    expect(bytes[7]).toBe(0xe9);
    expect(bytes.slice(8, 10)).toEqual([0x01, 0x00]);
    expect(bytes[10]).toBe(0xc3);
  });

  it("supports short jumps and conditional jumps", () => {
    expect(encode("jmp short done\nnop\ndone:\nhlt")[0]).toBe(0xeb);
    expect(encode("jmp done\nnop\ndone:\nhlt")[0]).toBe(0xe9);
    expect(encode("je done\nnop\ndone:\nhlt")[0]).toBe(0x74);
    expect(encode("jne done\nnop\ndone:\thlt")[0]).toBe(0x75);
    expect(encode("jb done\nnop\ndone:\thlt")[0]).toBe(0x72);
    expect(encode("jbe done\nnop\ndone:\thlt")[0]).toBe(0x76);
    expect(encode("ja done\nnop\ndone:\thlt")[0]).toBe(0x77);
    expect(encode("jl done\nnop\ndone:\thlt")[0]).toBe(0x7c);
    expect(encode("jge done\nnop\ndone:\thlt")[0]).toBe(0x7d);
    expect(encode("loop done\nnop\ndone:\thlt")[0]).toBe(0xe2);
    expect(encode("jcxz done\nnop\ndone:\thlt")[0]).toBe(0xe3);
  });

  it("assembles data directives, labels and equates", () => {
    const assembly = assemble([
      "count equ 3",
      "value db 42",
      "dw 1234h",
      "text db 'Hi', 0",
      "org 100h",
      "start:",
      "mov al, count",
      "mov bx, offset value",
    ].join("\n"));

    expect(assembly.entryPoint).toBe(0x100);
    expect(encode([
      "count equ 3",
      "value db 42",
      "dw 1234h",
      "text db 'Hi', 0",
      "org 100h",
      "start:",
      "mov al, count",
      "mov bx, offset value",
    ].join("\n")).slice(0, 5)).toEqual([0xb0, 0x03, 0xbb, 0x00, 0x01]);
    expect(assembly.symbols.find((symbol) => symbol.name === "count")?.value).toBe(3);
    expect(assembly.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(assembly.listing.filter((entry) => entry.label === "start")).toHaveLength(1);
  });

  it("resolves the same code layout on both passes", () => {
    const assembly = assemble([
      "org 100h",
      "start:",
      "mov ax, tail_value",
      "jmp start",
      "tail_value dw 4321h",
    ].join("\n"));

    expect(assembly.symbols.find((symbol) => symbol.name === "tail_value")?.value).toBe(0x106);
    expect(encode([
      "org 100h",
      "start:",
      "mov ax, tail_value",
      "jmp start",
      "tail_value dw 4321h",
    ].join("\n"))).toEqual([0xb8, 0x06, 0x01, 0xe9, 0xfa, 0xff, 0x21, 0x43]);
  });

  it("reports clear errors for unsupported and malformed input", () => {
    const undefinedSymbol = asmError("mov ax, nowhere");
    expect(undefinedSymbol?.message).toMatch(/nowhere/);

    const widthMismatch = asmError("mov ax, bl");
    expect(widthMismatch?.message).toMatch(/same size/);

    const unsupported = asmError("aas");
    expect(unsupported?.message).toMatch(/not supported/);

    const outOfRange = asmError("mov ax, 12345h");
    expect(outOfRange?.message).toMatch(/immediate/);

    const missingOperand = asmError("mov ax");
    expect(missingOperand?.message).toMatch(/MOV needs two operands/);

    const badRange = asmError("inc [bx]");
    expect(badRange).toBeDefined();
    expect(badRange?.message ?? "").toMatch(/register|size/);
  });
});

describe("x86 decoder", () => {
  it("disassembles the bytes produced by the assembler", () => {
    const context = contextFor("mov ax, bx\nadd al, 5\njmp short end\nend:\nint 21h");
    const first = decodeAt({ registers: context.registers, memory: context.memory }, 0x100);
    expect(first.mnemonic).toBe("mov");
    expect(first.text).toContain("MOV");
    expect(first.length).toBe(2);

    const second = decodeAt({ registers: context.registers, memory: context.memory }, 0x102);
    expect(second.mnemonic).toBe("add");

    const third = decodeAt({ registers: context.registers, memory: context.memory }, 0x104);
    expect(third.mnemonic).toBe("jmp");
    expect(third.jumpTarget).toBe(0x106);
  });

  it("resolves memory operand segments from the base register", () => {
    const context = contextFor("mov ax, [bp]");
    const [, stack] = decodeAt({ registers: context.registers, memory: context.memory }, 0x100).operands;
    expect(stack?.kind).toBe("memory");
    if (stack?.kind === "memory") {
      expect(stack.segment).toBe("ss");
    }

    const dataContext = contextFor("mov ax, [bx]");
    const [data] = decodeAt({ registers: dataContext.registers, memory: dataContext.memory }, 0x100).operands;
    if (data?.kind === "memory") {
      expect(data.segment).toBe("ds");
    }
  });

  it("rejects opcodes this core does not implement", () => {
    const context = contextFor("hlt");
    context.memory[0x100] = 0x9c;
    expect(() => decodeAt({ registers: context.registers, memory: context.memory }, 0x100)).toThrow(/not supported/);
  });
});

describe("x86 execution", () => {
  it("initialises the machine state like a COM program", () => {
    const result = run("hlt");
    expect(result.haltReason).toBe("halted");
    expect(result.finalRegisters.cs).toBe(0);
    expect(result.finalRegisters.ss).toBe(0x1000);
    expect(result.finalRegisters.sp).toBe(0xfffe);
    expect(result.finalRegisters.ds).toBe(0);
  });

  it("executes arithmetic and updates the flags", () => {
    const result = run("mov ax, 5\nadd ax, 7\nhlt");
    expect(result.finalRegisters.ax).toBe(12);
    expect(numberToFlags(result.finalRegisters.flags).zf).toBe(false);

    const zero = run("mov ax, 5\nsub ax, 5\nhlt");
    expect(zero.finalRegisters.ax).toBe(0);
    expect(zero.finalFlags.zf).toBe(true);
    expect(zero.finalFlags.sf).toBe(false);

    const carry = run("mov al, 0ffh\nadd al, 1\nhlt");
    expect(carry.finalRegisters.ax).toBe(0x0000);
    expect(carry.finalFlags.cf).toBe(true);
    expect(carry.finalFlags.sf).toBe(false);
    expect(carry.finalFlags.zf).toBe(true);
    expect(carry.finalFlags.af).toBe(true);

    const auxiliary = run("mov al, 0fh\nadd al, 1\nhlt");
    expect(auxiliary.finalRegisters.ax).toBe(0x0010);
    expect(auxiliary.finalFlags.af).toBe(true);

    const overflow = run("mov al, 7fh\nadd al, 1\nhlt");
    expect(overflow.finalRegisters.ax & 0xff).toBe(0x80);
    expect(overflow.finalFlags.of).toBe(true);
    expect(overflow.finalFlags.sf).toBe(true);
  });

  it("handles 8-bit register halves independently", () => {
    const result = run("mov ax, 1234h\nmov ah, 56h\nhlt");
    expect(result.finalRegisters.ax).toBe(0x5634);
  });

  it("reads and writes memory through segments", () => {
    const result = run([
      "mov bx, 0",
      "mov ax, 1111h",
      "mov [bx], ax",
      "mov cx, 0",
      "mov cx, [bx]",
      "hlt",
    ].join("\n"));

    expect(result.finalRegisters.cx).toBe(0x1111);
    expect(result.accesses.some((access) => access.address === 0 && access.size === 2 && access.value === 0x1111)).toBe(true);
  });

  it("runs loops and branches", () => {
    const result = run([
      "mov ax, 0",
      "mov cx, 5",
      "again:",
      "add ax, 2",
      "loop again",
      "hlt",
    ].join("\n"));

    expect(result.finalRegisters.ax).toBe(10);
    expect(result.finalRegisters.cx).toBe(0);
    expect(result.haltReason).toBe("halted");
    expect(result.trace.length).toBe(2 + 5 * 2 + 1);
  });

  it("skips untaken conditional branches", () => {
    const taken = run([
      "mov ax, 1",
      "cmp ax, 1",
      "je taken",
      "mov ax, 0",
      "taken:",
      "hlt",
    ].join("\n"));

    expect(taken.finalRegisters.ax).toBe(1);
    expect(taken.steps).toBe(4);

    const untaken = run([
      "mov ax, 2",
      "cmp ax, 1",
      "je taken",
      "mov ax, 0",
      "taken:",
      "hlt",
    ].join("\n"));

    expect(untaken.finalRegisters.ax).toBe(0);
    expect(untaken.steps).toBe(5);
  });

  it("uses the stack for push, pop, call and ret", () => {
    const result = run([
      "mov ax, 1234h",
      "push ax",
      "mov ax, 0",
      "pop bx",
      "call sub",
      "hlt",
      "sub:",
      "mov ax, 5678h",
      "ret",
    ].join("\n"));

    expect(result.finalRegisters.bx).toBe(0x1234);
    expect(result.finalRegisters.ax).toBe(0x5678);
    expect(result.finalRegisters.sp).toBe(0xfffe);
    expect(result.haltReason).toBe("halted");
  });

  it("multiplies and divides 16-bit values", () => {
    const multiply = run("mov ax, 1000\nmov bx, 3\nmul bx\nhlt");
    expect(multiply.finalRegisters.ax).toBe(3000);
    expect(multiply.finalRegisters.dx).toBe(0);

    const divide = run("mov dx, 0\nmov ax, 3000\nmov bx, 3\ndiv bx\nhlt");
    expect(divide.finalRegisters.ax).toBe(1000);
    expect(divide.finalRegisters.dx).toBe(0);

    const remainder = run("mov dx, 0\nmov ax, 1001\nmov bx, 10\ndiv bx\nhlt");
    expect(remainder.finalRegisters.ax).toBe(100);
    expect(remainder.finalRegisters.dx).toBe(1);

    const negative = run("mov ax, -2\ncwd\nmov bx, 2\nidiv bx\nhlt");
    expect(negative.finalRegisters.ax & 0xffff).toBe(0xffff);
    expect(negative.finalRegisters.dx & 0xffff).toBe(0);

    const cbw = run("mov al, 0feh\ncbw\nhlt");
    expect(cbw.finalRegisters.ax & 0xffff).toBe(0xfffe);
  });

  it("shifts and rotates", () => {
    expect(run("mov ax, 1\nshl ax, 4\nhlt").finalRegisters.ax).toBe(0x10);
    expect(run("mov ax, 16\nshr ax, 2\nhlt").finalRegisters.ax).toBe(4);
    expect(run("mov al, 0x81\nsar al, 1\nhlt").finalRegisters.ax & 0xff).toBe(0xc0);
    expect(run("mov al, 0x81\nrol al, 1\nhlt").finalRegisters.ax & 0xff).toBe(0x03);
    expect(run("mov al, 0x03\nror al, 1\nhlt").finalRegisters.ax & 0xff).toBe(0x81);
    expect(run("mov ax, 8000h\nshl ax, 1\nhlt").finalFlags.cf).toBe(true);
  });

  it("runs string instructions with repeat prefixes", () => {
    const result = run([
      "cld",
      "mov si, 0",
      "mov di, 0",
      "mov cx, 4",
      "rep movsb",
      "hlt",
    ].join("\n"));

    expect(result.haltReason).toBe("halted");
    expect(result.finalRegisters.cx).toBe(0);
    expect(result.finalRegisters.si).toBe(4);
    expect(result.finalRegisters.di).toBe(4);
    expect(result.trace.find((step) => step.text.includes("rep"))?.reads.length).toBeGreaterThan(0);
  });

  it("stores a word repeatedly with stosw", () => {
    const result = run([
      "cld",
      "mov di, 0",
      "mov ax, 1234h",
      "mov cx, 3",
      "rep stosw",
      "hlt",
    ].join("\n"));

    expect(result.finalRegisters.cx).toBe(0);
    const writes = result.trace.flatMap((step) => step.writes);
    expect(writes.filter((access) => access.size === 2 && access.value === 0x1234).length).toBeGreaterThanOrEqual(3);
  });

  it("counts down when the direction flag is set", () => {
    const result = run("std\nmov di, 10\nmov al, 1\nstosb\nhlt");
    expect(result.finalRegisters.di).toBe(9);
  });

  it("prints characters through the emulated dos interrupts", () => {
    const character = run("mov dx, 'A'\nmov ah, 2\nint 21h\nint 20h");
    expect(character.console).toEqual(["A"]);
    expect(character.haltReason).toBe("terminated");

    const stringProgram = assemble([
      "org 100h",
      "mov dx, offset msg",
      "mov ah, 9",
      "int 21h",
      "int 20h",
      "msg db 'Hi!', 0",
    ].join("\n"));

    expect(stringProgram.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const printed = simulateX86({ source: [
      "org 100h",
      "mov dx, offset msg",
      "mov ah, 9",
      "int 21h",
      "int 20h",
      "msg db 'Hi!', 0",
    ].join("\n") });
    expect(printed.console).toEqual(["Hi!"]);
  });

  it("reads trainer ports", () => {
    const reads: number[] = [];
    const result = run("mov dx, 10h\nin al, dx\nhlt", {
      device: {
        read: (port) => {
          reads.push(port);
          return 0x5a;
        },
        write: () => undefined,
      },
    });

    expect(reads).toEqual([0x10]);
    expect(result.finalRegisters.ax & 0xff).toBe(0x5a);
    expect(result.portValues[0x10]).toBe(0x5a);
  });

  it("writes trainer ports and records the values", () => {
    const written: Array<[number, number]> = [];
    const result = run("mov al, 0fh\nout 20h, al\nmov ax, 0abcdh\nout 21h, ax\nhlt", {
      device: {
        read: () => 0,
        write: (port, value) => {
          written.push([port, value]);
        },
      },
    });

    expect(written).toEqual([[0x20, 0x0f], [0x21, 0xabcd]]);
    expect(result.portValues[0x20]).toBe(0x0f);
    expect(result.portValues[0x21]).toBe(0xabcd);
  });

  it("reports divide errors instead of producing wrong results", () => {
    const result = run("mov ax, 10\nmov bx, 0\ndiv bx\nhlt");
    expect(result.haltReason).toBe("error");
    expect(result.error?.message).toMatch(/divide error/);
  });

  it("reports unsupported interrupt functions", () => {
    const result = run("mov ax, 3f00h\nint 21h\nhlt");
    expect(result.haltReason).toBe("error");
    expect(result.error?.message).toMatch(/not emulated/);
  });

  it("maps a runtime failure back to the source line", () => {
    const result = run([
      "mov ax, 1",
      "mov bx, 0",
      "div bx",
      "hlt",
    ].join("\n"));

    expect(result.haltReason).toBe("error");
    expect(result.error?.line).toBe(3);
  });

  it("stops at the step limit for runaway programs", () => {
    const result = run("again:\njmp again", { maxSteps: 50 });
    expect(result.haltReason).toBe("step-limit");
    expect(result.steps).toBe(50);
  });

  it("surfaces assembly errors without running anything", () => {
    const result = run("mov ax, undeclared_symbol");
    expect(result.haltReason).toBe("error");
    expect(result.steps).toBe(0);
    expect(result.error?.line).toBe(1);
  });

  it("throws a runtime error when the core meets invalid bytes", () => {
    const context = contextFor("hlt");
    context.memory[0x100] = 0x62;
    expect(() => executeInstruction(context)).toThrow();
  });

  it("keeps the string source on ds when es is overridden", () => {
    const context = contextFor("hlt");
    context.memory[0x100] = 0x26;
    context.memory[0x101] = 0xa4;
    context.registers.si = 0;
    context.registers.di = 0;
    executeInstruction(context);
    expect(context.registers.si).toBe(1);
    expect(context.reads[0]?.segment).toBe(0);
    expect(context.writes[0]?.segment).toBe(0);
  });
});

describe("x86 runtime errors", () => {
  it("carries the instruction pointer", () => {
    const error = new X86RuntimeError("boom", 0x1234);
    expect(error.ip).toBe(0x1234);
    expect(error.message).toBe("boom");
  });
});
