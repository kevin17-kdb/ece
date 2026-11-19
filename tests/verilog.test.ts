import { describe, expect, it } from "vitest";
import { simulateVerilog, type VerilogSimulationResult, type VerilogSourceFile } from "../src/lib/verilog/simulator";
import { parseSource } from "../src/lib/verilog/parser";
import { VerilogError } from "../src/lib/verilog/types";

function run(sources: VerilogSourceFile[], options = {}): VerilogSimulationResult {
  return simulateVerilog(sources, options);
}

function logText(result: VerilogSimulationResult): string[] {
  return result.log.map((entry) => entry.text);
}

const fullAdder = `
module full_adder(input a, input b, input cin, output sum, output cout);
  assign sum = a ^ b ^ cin;
  assign cout = (a & b) | (a & cin) | (b & cin);
endmodule
`;

describe("verilog lexer and parser", () => {
  it("parses modules, ports, ranges, and processes", () => {
    const parsed = parseSource(
      `\`timescale 1ns / 1ps
module counter (input clk, input rst, output reg [3:0] q);
  parameter WIDTH = 4;
  always @(posedge clk or posedge rst) begin
    if (rst) q <= 4'b0000;
    else q <= q + 1;
  end
endmodule`,
      "counter.v",
    );

    expect(parsed.modules).toHaveLength(1);
    const [module] = parsed.modules;
    expect(module.name).toBe("counter");
    expect(module.ports.map((port) => `${port.name}:${port.direction}`)).toEqual(["clk:input", "rst:input", "q:output"]);
    expect(module.ports[2]?.isReg).toBe(true);
    expect(module.parameters.map((parameter) => parameter.name)).toEqual(["WIDTH"]);
    expect(module.processes).toHaveLength(1);
    expect(parsed.timescale?.unit).toBe(1_000_000_000);
  });

  it("reports unsupported constructs with a source location", () => {
    expect(() => parseSource("module m; task t; endtask endmodule", "m.v")).toThrowError(VerilogError);
    try {
      parseSource("module m;\n  logic [7:0] data;\nendmodule", "m.v");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(VerilogError);
      expect((error as VerilogError).message).toContain("SystemVerilog");
      expect((error as VerilogError).range.line).toBe(2);
    }
  });
});

describe("verilog combinational simulation", () => {
  it("evaluates a full adder for every input combination", () => {
    const result = run([
      { path: "full_adder.v", content: fullAdder },
      {
        path: "tb.v",
        content: `
module tb;
  reg a, b, cin;
  wire sum, cout;
  full_adder dut(.a(a), .b(b), .cin(cin), .sum(sum), .cout(cout));

  initial begin
    $display(" a b cin | sum cout");
    a = 0; b = 0; cin = 0; #1 $display(" %b %b  %b  |  %b   %b", a, b, cin, sum, cout);
    a = 0; b = 0; cin = 1; #1 $display(" %b %b  %b  |  %b   %b", a, b, cin, sum, cout);
    a = 0; b = 1; cin = 0; #1 $display(" %b %b  %b  |  %b   %b", a, b, cin, sum, cout);
    a = 0; b = 1; cin = 1; #1 $display(" %b %b  %b  |  %b   %b", a, b, cin, sum, cout);
    a = 1; b = 0; cin = 0; #1 $display(" %b %b  %b  |  %b   %b", a, b, cin, sum, cout);
    a = 1; b = 0; cin = 1; #1 $display(" %b %b  %b  |  %b   %b", a, b, cin, sum, cout);
    a = 1; b = 1; cin = 0; #1 $display(" %b %b  %b  |  %b   %b", a, b, cin, sum, cout);
    a = 1; b = 1; cin = 1; #1 $display(" %b %b  %b  |  %b   %b", a, b, cin, sum, cout);
    $finish;
  end
endmodule
`,
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.topModule).toBe("tb");
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const rows = logText(result).slice(1);
    expect(rows).toEqual([
      " 0 0  0  |  0   0",
      " 0 0  1  |  1   0",
      " 0 1  0  |  1   0",
      " 0 1  1  |  0   1",
      " 1 0  0  |  1   0",
      " 1 0  1  |  0   1",
      " 1 1  0  |  0   1",
      " 1 1  1  |  1   1",
    ]);
  });

  it("resolves gate primitives and four-state behaviour", () => {
    const result = run([
      {
        path: "gates.v",
        content: `
module tb;
  reg a, b;
  wire y_and, y_or, y_not;
  and (y_and, a, b);
  or  (y_or, a, b);
  not (y_not, a);

  initial begin
    a = 0; b = 0; #1 $display("and=%b or=%b not=%b", y_and, y_or, y_not);
    a = 1; b = 1; #1 $display("and=%b or=%b not=%b", y_and, y_or, y_not);
    a = 1'bx; b = 1'bx; #1 $display("unknown input -> %b", y_and);
    $finish;
  end
endmodule
`,
      },
    ]);

    expect(logText(result)).toEqual([
      "and=0 or=0 not=1",
      "and=1 or=1 not=0",
      "unknown input -> x",
    ]);
  });

  it("supports vectors, part selects, case statements, and parameters", () => {
    const result = run([
      {
        path: "mux.v",
        content: `
module mux #(parameter WIDTH = 4) (input [WIDTH-1:0] data, input [1:0] sel, output reg [WIDTH-1:0] out);
  always @(*) begin
    case (sel)
      2'b00: out = data;
      2'b01: out = data << 1;
      2'b10: out = {data[0], data[WIDTH-1:1]};
      default: out = {WIDTH{1'b0}};
    endcase
  end
endmodule
`,
      },
      {
        path: "tb.v",
        content: `
module tb;
  reg [3:0] data;
  reg [1:0] sel;
  wire [3:0] out;
  mux #(.WIDTH(4)) dut(.data(data), .sel(sel), .out(out));

  initial begin
    data = 4'b1010; sel = 2'b00; #1 $display("%b", out);
    sel = 2'b01; #1 $display("%b", out);
    sel = 2'b10; #1 $display("%b", out);
    sel = 2'b11; #1 $display("%b", out);
    $finish;
  end
endmodule
`,
      },
    ]);

    expect(result.ok).toBe(true);
    expect(logText(result)).toEqual(["1010", "0100", "0101", "0000"]);
  });
});

describe("verilog sequential simulation", () => {
  it("clocks a flip-flop and records a waveform", () => {
    const result = run([
      {
        path: "dff.v",
        content: `
module tb;
  reg clk, d, rst;
  reg [3:0] q;

  always #5 clk = ~clk;

  always @(posedge clk or posedge rst) begin
    if (rst) q <= 4'b0000;
    else q <= q + 1;
  end

  initial begin
    clk = 0; d = 1; rst = 1;
    #12 rst = 0;
    #40 $finish;
  end

  initial $monitor("t=%0t clk=%b q=%0d", $time, clk, q);
endmodule
`,
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.samples.length).toBeGreaterThan(4);
    expect(result.samples[0]?.timeNs).toBe(0);
    const clockEdges = result.samples.filter((sample) => sample.values.clk === "11");
    expect(clockEdges.length).toBeGreaterThanOrEqual(3);
    const final = result.finalValues.q;
    expect(final).toBeDefined();
  });

  it("keeps counters in sync with a self-checking testbench", () => {
    const result = run([
      {
        path: "counter.v",
        content: `
module counter8 (input clk, input rst, output reg [7:0] count);
  always @(posedge clk) begin
    if (rst) count <= 8'd0;
    else count <= count + 8'd1;
  end
endmodule
`,
      },
      {
        path: "tb.v",
        content: `
module tb;
  reg clk = 0;
  reg rst = 1;
  wire [7:0] count;
  integer failures = 0;
  integer index;

  counter8 dut(.clk(clk), .rst(rst), .count(count));

  always #5 clk = ~clk;

  initial begin
    #12 rst = 0;
    for (index = 1; index <= 4; index = index + 1) begin
      @(posedge clk);
      #1;
      if (count !== index) begin
        failures = failures + 1;
        $display("FAIL expected %0d got %0d", index, count);
      end
    end
    if (failures == 0) $display("PASS counter reached %0d", count);
    $finish;
  end
endmodule
`,
      },
    ]);

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(logText(result)).toContain("PASS counter reached 4");
  });

  it("handles a loop-free always block with an asynchronous reset", () => {
    const result = run([
      {
        path: "shift.v",
        content: `
module tb;
  reg clk, rst, in;
  reg [3:0] q = 4'b0000;
  integer i;

  always #1 clk = ~clk;
  always @(posedge clk or posedge rst)
    if (rst) q <= 4'b0000;
    else q <= {q[2:0], in};

  initial begin
    clk = 0; rst = 0; in = 1;
    for (i = 0; i < 4; i = i + 1) begin
      @(posedge clk);
    end
    #1 $display("q=%b", q);
    $finish;
  end
endmodule
`,
      },
    ]);

    expect(result.ok).toBe(true);
    expect(logText(result)).toContain("q=1111");
  });
});

describe("verilog diagnostics and limits", () => {
  it("reports undeclared signals with a line number", () => {
    const result = run([
      {
        path: "bad.v",
        content: `module tb;
  reg a;
  initial begin
    a = b + 1;
    $finish;
  end
endmodule
`,
      },
    ]);

    expect(result.ok).toBe(false);
    const error = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    expect(error?.message).toContain("b");
    expect(error?.line).toBe(4);
    expect(error?.file).toBe("bad.v");
  });

  it("warns when nothing is scheduled and no $finish is used", () => {
    const result = run([
      {
        path: "idle.v",
        content: `module tb;
  reg a;
  initial a = 1;
endmodule
`,
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("waiting forever"))).toBe(true);
  });

  it("stops runaway simulations instead of hanging", () => {
    const result = run(
      [
        {
          path: "loop.v",
          content: `module tb;
  reg clk = 0;
  reg a = 0;
  always #1 clk = ~clk;
  always @(posedge clk) a = ~a;
  always @* a = ~a;
  initial #1000 $finish;
endmodule
`,
        },
      ],
      { maxSteps: 50_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("steps"))).toBe(true);
  });

  it("settles four-state combinational feedback to x instead of oscillating", () => {
    const result = run([
      {
        path: "osc.v",
        content: `module tb;
  wire a, b, c;
  not (a, b);
  not (b, c);
  not (c, a);
  initial #1 $display("ring=%b%b%b", a, b, c);
  initial #2 $finish;
endmodule
`,
      },
    ]);

    expect(result.ok).toBe(true);
    expect(logText(result)).toEqual(["ring=xxx"]);
  });

  it("rejects recursive module instantiation", () => {
    const result = run([
      {
        path: "rec.v",
        content: `module a;
  b inner();
endmodule
module b;
  a outer();
endmodule
module tb;
  a top();
  initial #1 $finish;
endmodule
`,
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("Recursive"))).toBe(true);
  });
});
