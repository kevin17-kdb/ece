import type { X86Device } from "./x86/cpu";
import type { X86Document } from "../types/project";

export const trainerPorts = {
  switchLow: 0x10,
  switchHigh: 0x11,
  ledLow: 0x20,
  ledHigh: 0x21,
} as const;

export interface TrainerDeviceInputs {
  switches?: Record<number, number>;
}

export interface TrainerDevice {
  device: X86Device;
  outputs: Record<number, number>;
}

export function createTrainerDevice(inputs: TrainerDeviceInputs = {}): TrainerDevice {
  const switches = inputs.switches ?? {};
  const outputs: Record<number, number> = {};
  return {
    outputs,
    device: {
      read: (port) => (switches[port] ?? 0) & 0xff,
      write: (port, value) => {
        outputs[port] = value & 0xffff;
      },
    },
  };
}

const registerDemo = `; 8086 Register Demo
; The machine starts like a DOS COM program: CS = DS = ES = 0, SS = 1000h.
; Step through the listing to watch registers, flags, and memory change.

        org 100h

start:  mov ax, 0005h          ; load a starting value
        mov bx, 0007h          ; and a second operand

        add ax, bx             ; ax = 000ch, watch ZF/SF/CF/AF/OF
        sub ax, 0002h          ; ax = 000ah

        mov cx, ax             ; copy the result
        mov [200h], cx         ; store it in the data area
        mov dx, [200h]         ; read it back into dx

        mov ah, 9              ; DOS: print a $-terminated string
        mov dx, offset banner
        int 21h

        int 20h                ; DOS: terminate

banner  db '8086 demo: registers, flags, and memory', 0dh, 0ah, 24h
`;

const trainerDemo = `; 8086 Trainer Demo
; Port 10h/11h read the two 8-bit switch banks.
; Port 20h/21h drive the two 8-bit LED banks.

        org 100h

start:  mov dx, 10h            ; switch bank 0
        in  al, dx
        mov bl, al

        mov dx, 11h            ; switch bank 1
        in  al, dx

        add al, bl             ; sum the two banks
        mov dx, 20h            ; LED bank 0
        out dx, al             ; low byte of the sum

        mov al, ah             ; carry into high LED bank
        adc al, 0
        mov dx, 21h
        out dx, al

        mov ah, 9
        mov dx, offset banner
        int 21h

        int 20h

banner  db '8086 trainer: switches -> adder -> LEDs', 0dh, 0ah, 24h
`;

const template = `; New 8086 program
; Supported directives: org, equ, db, dw, label:
; Supported I/O: in/out with an immediate port or dx.

        org 100h

start:  mov ax, 0
        mov bx, 0

        hlt
`;

export function createX86Template(): X86Document {
  return { source: template, machineCode: [] };
}

export function createX86RegisterStarter(): X86Document {
  return { source: registerDemo, machineCode: [] };
}

export function createX86TrainerStarter(): X86Document {
  return { source: trainerDemo, machineCode: [] };
}
