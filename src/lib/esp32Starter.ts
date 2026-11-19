import type { McuDocument } from "../types/project";

export interface Esp32StarterProgram {
  id: string;
  name: string;
  description: string;
  source: string;
}

export const esp32StarterPrograms: Esp32StarterProgram[] = [
  {
    id: "blink",
    name: "Blink GPIO0-7",
    description: "Walk a lit bit across GPIO0–GPIO7 through the GPIO_OUT register, then halt.",
    source: [
      "# Walk a lit bit across GPIO0..7 (ESP32-C3 GPIO_OUT_REG)",
      "    li   a1, 0x60004000   # GPIO base address",
      "    li   a2, 1            # first bit",
      "    li   a4, 8            # number of steps",
      "loop:",
      "    sw   a2, 4(a1)        # GPIO_OUT_REG = a2",
      "    slli a2, a2, 1        # shift the lit bit left",
      "    addi a4, a4, -1",
      "    bne  a4, x0, loop",
      "    ebreak",
    ].join("\n"),
  },
  {
    id: "count",
    name: "Sum 1 to 10",
    description: "Accumulate 1..10 in a0 using a real branch loop, then halt.",
    source: [
      "# Sum 1..10 in a0",
      "    li   a0, 0",
      "    li   a1, 1",
      "    li   a2, 11",
      "loop:",
      "    add  a0, a0, a1",
      "    addi a1, a1, 1",
      "    blt  a1, a2, loop",
      "    ebreak",
    ].join("\n"),
  },
  {
    id: "hello",
    name: "UART greeting",
    description: "Write \"Hi\" to the UART TX register and halt.",
    source: [
      "# Send a greeting to the UART transmit register",
      "    li   a1, 0x60000000   # UART0 base",
      "    li   a2, 0x48         # 'H'",
      "    sb   a2, 0(a1)",
      "    li   a2, 0x69         # 'i'",
      "    sb   a2, 0(a1)",
      "    li   a2, 0x0a         # newline",
      "    sb   a2, 0(a1)",
      "    ebreak",
    ].join("\n"),
  },
];

export function createEsp32Template(source = esp32StarterPrograms[0].source): McuDocument {
  return {
    targetId: "esp32c3",
    files: [{ path: "main.s", language: "assembly", content: source }],
  };
}

export function createEsp32Starter(): McuDocument {
  return createEsp32Template();
}

export function getEsp32Source(document: McuDocument | undefined): string {
  return document?.files[0]?.content ?? "";
}
