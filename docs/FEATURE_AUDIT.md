# Universal Electronics Lab — Feature Audit

Status: Phase A deliverable. This document describes what the application actually does today, distinguishes working behavior from placeholders, and gates the phased UI/UX + feature work (Sprints 1–8). It must be updated as sprints land.

Verified with: `npx vitest run` (157 tests / 23 files passing), `npm run typecheck`, `npm run lint`, `npm run build`.

---

## 1. Application shape

- Stack: React 19 + TypeScript (strict) + Vite 8, Vitest 4, ESLint 10. No backend; projects persist to `localStorage`.
- Shell: `App.tsx` (top bar, mode tabs, create modal) → `ProjectSidebar` + `main` (`Dashboard` or `WorkspaceView`).
- Workspace modes: `circuit`, `hdl`, `x86`, `mcu`, `esp32`, `experiments` (`src/types/project.ts`).
- Document model per project: `{ circuit?, hdl?, x86?, mcu?, esp32?, experiments? }`.
- Dev server: Vite default **http://localhost:5173** (`vite.config.ts` has no `server.port`).

### Source inventory

| Area | Files | Assessment |
| --- | --- | --- |
| Shell/UI | `App.tsx`, `Dashboard.tsx`, `ProjectSidebar.tsx`, `CreateProjectModal.tsx`, `Icon.tsx`, `WorkspaceView.tsx` | Working, but stale "Phase 1 / next phase" copy |
| Circuit UI | `CircuitWorkspace.tsx` | Working schematic editor + sim |
| Circuit engine | `circuitCatalog.ts`, `circuitOperations.ts`, `digitalSimulation.ts`, `netlist.ts` | Real deterministic digital simulator |
| HDL UI | `HDLWorkspace.tsx`, `CodeEditor.tsx`, `WaveformViewer.tsx` | Working |
| HDL engine | `verilog/{lexer,parser,simulator,values,types}.ts` | Real Verilog subset + event-driven sim |
| x86 UI | `X86Workspace.tsx` | Working |
| x86 engine | `x86/{assembler,decoder,cpu,simulator,types}.ts` | Real two-pass assembler + 8086 CPU |
| MCU UI | `MCUWorkspace.tsx` | Working |
| MCU engine | `mcu8051/{assembler,simulator,types}.ts` | Real 8051 subset assembler + CPU |
| ESP32 UI | `ESP32Workspace.tsx` | Working |
| ESP32 engine | `esp32/{assembler,simulator,types}.ts` | Real RV32I subset assembler + CPU |
| Shared | `waveform.ts` | Waveform capture for circuit/HDL/x86/mcu/esp32 |
| Persistence | `projectStore.ts` | localStorage + starter seeding |
| MCU | `mcuStarter.ts` | 3 starter programs (8051) |
| ESP32 | `esp32Starter.ts` | 3 starter programs (RV32I) |
| Experiments UI | `ExperimentsWorkspace.tsx` | Working |
| Experiments engine | `experiments.ts` | 5 guided labs with real auto-checks |
| Styles | `styles.css` (~57 KB) | Single global sheet |

---

## 2. What is real vs. placeholder

**Fully implemented and functional**

- Circuit Lab schematic editing: place (20 component types incl. 74xx/40xx ICs, BCD decoder, 7-seg), drag to move (grid snap), rotate, delete, output→input wiring with net merge, component inspector, pan-free zoom (75–150%).
- Circuit simulation: deterministic fixed-point digital evaluation (gates, D flip-flops, 4-bit counters, BCD→7seg), power-pin validation, driver-conflict and floating-input diagnostics, component/unit/displays value tables, netlist + Spice-style export, logic-analyzer waveform capture.
- HDL: multi-file RTL + testbench, event-driven Verilog subset, diagnostics with gutter markers + jump-to-file, `$display` console, signal inspector, waveform.
- 8086: assembly editor + listing, step/run/reset, registers + byte registers, flags, paged hex memory, trainer ports (switches/LEDs), DOS console, register-trace waveform.
- 8051 (MCU): assembly editor + listing, step/run/reset, registers/PSW flags, P0–P3 ports with input switches, internal RAM, XRAM, serial console, diagnostics, port waveform.
- ESP32 (RV32I): assembly editor + listing, step/run/reset, RV32I register file (ABI names), GPIO output latch + input switches, UART TX console, diagnostics, GPIO waveform. Starter programs: Blink GPIO, Sum 1–10, UART greeting.
- Experiments: a guided-lab runner over the real 8086 and 8051 engines; each lab has a starter, objectives, steps, and automatic checks that execute the user's code on the matching simulator and report measured evidence.

**Placeholder / stub (must be clearly labeled, not presented as working)**

- **Circuit/HDL experiment engines**: the Experiments runner currently targets the 8086 and 8051 engines only; no circuit or HDL labs are offered yet.
- **ESP32 scope**: the ESP32 Lab implements a functional RV32I integer subset with a simplified GPIO/UART register map. It is *not* the full ESP-IDF/FreeRTOS C toolchain, and there are no timers, interrupts, caches, floating point, or Wi-Fi/Bluetooth peripherals.

**Misleading UI to correct (Sprint 1 priority)**

- `Dashboard.tsx`: "Phase 1 foundation is active" note; every project card shows a hardcoded `Draft` pill; the "Choose a lab" grid presents MCU/Experiments as available peers.
- `ProjectSidebar.tsx`: footer text "Phase 1 foundation".
- `WorkspaceView.tsx`: "Foundation workspace ready", "No simulation connected", disabled module buttons; also **unreachable for circuit/hdl/x86** (early-returns to the real workspaces) and only used for mcu/experiments.
- `Dashboard` mode copy promises features (breadboard connectivity, ESP32, VCD export, scope/multimeter) that do not exist.

---

## 3. Per-mode capability matrix

### Circuit Lab — implemented

Working: place/move/rotate/delete, wiring + net merge, inspector, simulated values, validation messages, netlist + Spice export, waveform, examples (AND gate, 74LS393 counter + 7447 + 7-seg trainer), autosave.

Missing / limitations:
- No breadboard view; no wire routing control (single L-shaped path); no multi-select/marquee; no copy/paste/duplicate; no undo/redo; no delete via keyboard; no zoom-to-fit; no component search/filter; palette is a flat long list.
- No analog (resistors/capacitors/transistors/supplies/ammeter/voltmeter); engine is digital-only.
- New components are auto-placed in a fixed 4-column cascade rather than at cursor/drop point.
- Save is implicit (no explicit save state, no unsaved indicator).

### Digital / HDL — implemented (subset)

Working: files + testbench, top-module select, run, diagnostics, console, signal hide, waveform.

Limitations: Verilog subset only (see on-screen help). No SystemVerilog, no RTL-to-schematic/block view despite dashboard copy.

### 8086 Lab — implemented

Working: assemble, listing + machine code, step/run/reset, registers/flags/memory, trainer ports, console, waveform.

Limitations: MASM subset; single 1 MiB address space; no breakpoints, no watch expressions, no source-level stepping of macros.

### MCU Lab — 8051 subset implemented (Sprint 6)

`MCUWorkspace` assembles a real 8051 assembly subset to machine code (`src/lib/mcu8051/assembler.ts`) and executes it on a step-accurate CPU (`src/lib/mcu8051/simulator.ts`): MOV/MOVX/MOVC, ADD/ADDC/SUBB/MUL/DIV, INC/DEC, logical/rotate ops, bit ops, jumps/calls, CJNE/DJNZ, PUSH/POP, RET/RETI, JMP @A+DPTR. UI shows listing, registers (PC/A/B/SP/DPTR/PSW/R0–R7), PSW flags, P0–P3 ports with input switches, internal RAM, serial console, diagnostics, and a port waveform. XRAM is a separate 64 KB array. Starter programs: Add and store, Walking LED, Serial greeting.

Limitations: no `DB`/`DW`/`DS`, no `EQU`/symbols beyond labels, no interrupts/timers/ADC/PWM/real UART baud timing; SBUF writes are pushed to the console as characters. (A separate ESP32-C3 target is offered in its own workspace.)

### Experiments — implemented (Sprint 7)

`ExperimentsWorkspace` presents a library of guided labs. Each `ExperimentDefinition` (`src/lib/experiments.ts`) carries objectives, steps, a starter program, a hint, and an `evaluate` function that runs the user's code on the real engine — `simulateX86` for 8086 labs and `runX8051` for 8051 labs — then returns pass/fail checks and measured evidence (registers, RAM, console). The UI shows the checklist, the evidence values, assembly errors, per-lab progress, and a solved count. Sources and completed labs persist on the project's `experiments` document.

Labs shipped: Sum 1–5 (8086 loop), Store a value in memory (8086), Count to ten in R0 (8051), Store a constant in RAM (8051), Send a serial greeting (8051).

Limitations: only 8086 and 8051 engines are covered; no circuit or HDL labs; no free-form grading beyond the defined checks; no timers/interrupts in the 8051 checker.

### ESP32 — implemented (RV32I subset)

`ESP32Workspace` targets the ESP32-C3. `src/lib/esp32/assembler.ts` is a two-pass RV32I assembler: directives `.org/.word/.byte/.space/.globl/.text/.data`, pseudo-instructions `li mv nop j jal ret ebreak ecall`, and real `addi add sub and or xor slli srli lui lw sw lb lbu sb beq bne blt bge jalr` with little-endian machine code and label resolution. `src/lib/esp32/simulator.ts` executes the encoding on a flat 64 KB memory model with `Int32` registers, intercepting a simplified ESP32-C3 peripheral window for GPIO (`GPIO_OUT` `0x60004004`, `GPIO_IN` `0x6000403c`) and UART TX (`0x60000000`). The UI shows the listing, the RV32I register file, the GPIO output latch + input switches, a read-only 64 KB data-memory viewer (navigable in 128-byte pages, reflecting the halted/paused CPU state), the UART console, diagnostics, and a GPIO waveform. Starter programs: Blink GPIO, Sum 1–10, UART greeting.

Limitations: integer RV32I subset only (no M/A/C extensions, CSR, interrupts, timers, caches, floating point, Wi-Fi/Bluetooth or the ESP-IDF C toolchain); memory is a flat 64 KB; `li` accepts numeric constants only — a non-numeric `li` operand is rejected with a clear diagnostic rather than producing mis-sized code; UART writes are pushed to the console as characters.

---

## 4. Testing coverage

Present (all passing, 157 tests / 23 files): `netlist`, `waveform`, `digitalSimulation`, `logicIc`, `hdlStarter`, `hdlWorkspace` (SSR), `verilog`, `x86` (34), `x86Workspace` (SSR), `circuitWorkspace`, `circuitOperations` (net merge, prune, edits), `editHistory` (undo/redo), `truthTable`, `watch`, `mcu8051` (11), `mcuWorkspace` (SSR), `esp32` (assembler encoding incl. li sizing + label rejection, RV32I execution, MMIO), `esp32Workspace` (SSR), `experiments` (catalog + real checks), `experimentsWorkspace` (SSR), `projectStore` (artifact counts, migration, v2 persistence + legacy v1 fallback), `appShell` (App shell, `CreateProjectModal`, `WorkspaceView` routing + lazy loaders), `shell`.

Gaps: no automated tests for interactive drag/drop internals of `CircuitWorkspace` (the pure `circuitOperations`/`editHistory` functions are now covered). Note `tsconfig.app.json` includes only `src`, so test files are not type-checked by `npm run build`.

---

## 5. Sprint plan (Phases B–I → Sprints 1–8)

Ordered; each sprint ends green (tests + typecheck + lint + build) and produces a written report.

1. **Sprint 1 — Audit + shell/UX foundation.** This audit; remove misleading "Phase 1/next phase" copy; honest status for mcu/experiments; redesign dashboard (real actions, no fake pills); clearer nav and empty states; consistent save/labeling; responsive shell.
2. **Sprint 2 — Circuit Lab UX.** Component search/filter, drop-at-cursor, multi-select + copy/paste/duplicate/delete via keyboard, undo/redo, zoom-to-fit, wire routing improvements, explicit save state, inspector polish.
3. **Sprint 3 — Circuit engine extensions.** Analog-aware components or clearly-scoped digital additions; measurement instruments (logic probe, truth table); expand IC catalog with models that are actually simulated.
4. **Sprint 4 — Shared instrumentation + waveform.** Unify circuit/HDL/x86/mcu waveform plumbing into one interface; add cursors/zoom/export; logic analyzer + scope-style views.
5. **Sprint 5 — 8086 Lab completion.** Breakpoints, watches, memory editing, richer trainer I/O, more directives/instructions.
6. **Sprint 6 — MCU Lab (8051 first).** Target definitions, assembler/C subset, loader, registers/SFR, GPIO + trainer I/O, pin waveform — real simulation only.
7. **Sprint 7 — ESP32 + Experiments.** Experiment library with runner and auto-checks — **done**. The ESP32 second target is **done** as a functional RV32I subset workspace (`esp32` mode) with assembler, simulator, GPIO/UART model, starter programs, waveform, and tests; scope limits are labeled in the UI.
8. **Sprint 8 — Architecture + hardening** — **done**. Stable autosave handlers (`useCallback` in `App`), shared `countProjectArtifacts`, versioned storage envelope with legacy v1 migration (`projectStore`), `aria-label`s on icon-only controls, and expanded coverage (`projectStore`, app shell).

---

## 7. Sprint status

| Sprint | Scope | Status |
| --- | --- | --- |
| 1 | Audit + shell/UX foundation | Done |
| 2 | Circuit Lab UX | Done |
| 3 | Circuit engine extensions (truth table, logic probe, buffer) | Done |
| 4 | Shared instrumentation + waveform | Done |
| 5 | 8086 Lab completion (breakpoints, watches, memory edit) | Done |
| 6 | MCU Lab (8051 subset, assembler + CPU + ports + RAM) | Done |
| 7 | Experiments runner (8086/8051 auto-checks) | Done |
| 7 | ESP32 second target (RV32I subset workspace) | Done |
| 8 | Architecture + hardening (stable handlers, storage migration, a11y, tests) | Done |
| 9 | Code-splitting (lazy workspaces) + Circuit test gap + ESP32 target | Done |


---

## 6. Known constraints / rules carried into implementation

- Every visible control must perform its advertised action; appearance-only controls are forbidden.
- Features that are not implemented must be labeled as such (no simulated results presented as real).
- Preserve existing projects and saved `localStorage` data across changes.
- Never claim a simulator/peripheral/board works unless it is actually implemented.
- Do not report tests as passing without running them.
