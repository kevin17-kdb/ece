import type { McuDocument } from "../types/project";

export interface McuStarterProgram {
  id: string;
  name: string;
  description: string;
  source: string;
}

export const mcuStarterPrograms: McuStarterProgram[] = [
  {
    id: "add",
    name: "Add and store",
    description: "Add two immediate bytes and store the sum in internal RAM.",
    source: [
      "; Add two bytes and store the sum in internal RAM (address 30h)",
      "        ORG 0000h",
      "START:  MOV A,#25h",
      "        ADD A,#13h",
      "        MOV 30h,A",
      "        SJMP $",
    ].join("\n"),
  },
  {
    id: "blink",
    name: "Walking LED",
    description: "Rotate a single lit bit across Port 1, then restart.",
    source: [
      "; Walk a single lit LED across Port 1 forever",
      "        ORG 0000h",
      "        MOV A,#01h",
      "AGAIN:  MOV P1,A",
      "        RL A",
      "        CJNE A,#01h,AGAIN",
      "        SJMP $",
    ].join("\n"),
  },
  {
    id: "serial",
    name: "Serial greeting",
    description: "Write a short message to the serial buffer (SBUF).",
    source: [
      "; Send a greeting to the serial buffer",
      "        ORG 0000h",
      "        MOV SBUF,#48h",
      "        MOV SBUF,#65h",
      "        MOV SBUF,#6Ch",
      "        MOV SBUF,#6Ch",
      "        MOV SBUF,#6Fh",
      "        MOV SBUF,#0Ah",
      "        SJMP $",
    ].join("\n"),
  },
];

export function createMcuTemplate(source = mcuStarterPrograms[0].source): McuDocument {
  return {
    targetId: "at89c51",
    files: [{ path: "main.asm", language: "assembly", content: source }],
  };
}

export function createMcuStarter(): McuDocument {
  return createMcuTemplate();
}

export function getMcuSource(document: McuDocument | undefined): string {
  return document?.files[0]?.content ?? "";
}

export function withMcuSource(document: McuDocument, source: string): McuDocument {
  const existing = document.files[0];
  return {
    ...document,
    files: existing
      ? document.files.map((file, index) => (index === 0 ? { ...file, content: source } : file))
      : [{ path: "main.asm", language: "assembly", content: source }],
  };
}
