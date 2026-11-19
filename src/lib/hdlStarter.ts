import type { HdlDocument } from "../types/project";

const fullAdderRtl = `// full_adder.v
// A 1-bit full adder built from two half adders.
module full_adder (
  input wire a,
  input wire b,
  input wire cin,
  output wire sum,
  output wire cout
);

  wire lower_sum;
  wire lower_carry;
  wire upper_carry;

  // Bit 0: a + b
  half_adder lower_stage (
    .a(a),
    .b(b),
    .sum(lower_sum),
    .carry(lower_carry)
  );

  // Bit 1: lower_sum + cin
  half_adder upper_stage (
    .a(lower_sum),
    .b(cin),
    .sum(sum),
    .carry(upper_carry)
  );

  // A carry out of either bit position is a carry out of the adder.
  assign cout = lower_carry | upper_carry;

endmodule
`;

const halfAdderRtl = `// half_adder.v
module half_adder (
  input wire a,
  input wire b,
  output wire sum,
  output wire carry
);

  assign sum = a ^ b;
  assign carry = a & b;

endmodule
`;

const fullAdderTestbench = `// tb_full_adder.v
// Self-checking testbench: sweeps all 8 input combinations.
\`timescale 1ns / 1ps

module tb_full_adder;

  reg  a;
  reg  b;
  reg  cin;
  wire sum;
  wire cout;

  integer index;
  integer errors;

  full_adder dut (
    .a(a),
    .b(b),
    .cin(cin),
    .sum(sum),
    .cout(cout)
  );

  initial begin
    $display("tb_full_adder: exhaustive full-adder check");
    errors = 0;

    for (index = 0; index < 8; index = index + 1) begin
      a   = index[2];
      b   = index[1];
      cin = index[0];
      #1;

      if (sum !== (index[2] ^ index[1] ^ index[0]) || cout !== ((index[2] & index[1]) | (index[0] & (index[2] ^ index[1])))) begin
        errors = errors + 1;
        $display("  FAIL a=%b b=%b cin=%b -> sum=%b cout=%b", a, b, cin, sum, cout);
      end else begin
        $display("  ok   a=%b b=%b cin=%b -> sum=%b cout=%b", a, b, cin, sum, cout);
      end
    end

    if (errors == 0) begin
      $display("PASS full_adder: 8 of 8 combinations matched");
    end else begin
      $display("FAIL full_adder: %0d mismatches", errors);
    end

    $finish;
  end

endmodule
`;

const counterRtl = `// counter.v
// A free-running 4-bit up counter with a synchronous reset.
\`timescale 1ns / 1ps

module counter #(
  parameter WIDTH = 4
) (
  input  wire              clk,
  input  wire              rst,
  output reg  [WIDTH-1:0]  count
);

  always @(posedge clk) begin
    if (rst) begin
      count <= {WIDTH{1'b0}};
    end else begin
      count <= count + 1'b1;
    end
  end

endmodule
`;

const counterTestbench = `// tb_counter.v
// Drives a clock, releases the reset, and checks the counter sequence.
\`timescale 1ns / 1ps

module tb_counter;

  reg  clk;
  reg  rst;
  wire [3:0] count;

  integer cycle;
  integer errors;

  counter dut (
    .clk(clk),
    .rst(rst),
    .count(count)
  );

  initial begin
    clk = 1'b0;
    rst = 1'b1;
    errors = 0;
    $display("tb_counter: 4-bit up counter");

    repeat (2) #5 clk = ~clk;
    rst = 1'b0;

    for (cycle = 1; cycle <= 4; cycle = cycle + 1) begin
      #5 clk = ~clk;
      #5 clk = ~clk;
      if (count !== cycle) begin
        errors = errors + 1;
        $display("  FAIL cycle %0d: count = %b", cycle, count);
      end else begin
        $display("  ok   cycle %0d: count = %b at %0t", cycle, count, $time);
      end
    end

    if (errors == 0) begin
      $display("PASS counter reached %0d", count);
    end else begin
      $display("FAIL counter: %0d mismatches", errors);
    end

    $finish;
  end

endmodule
`;

const templateRtl = `// combinational.v
module combinational (
  input  wire a,
  input  wire b,
  output wire sum,
  output wire carry
);

  assign sum = a ^ b;
  assign carry = a & b;

endmodule
`;

const templateTestbench = `// tb_combinational.v
// Self-checking testbench: sweeps all 4 input combinations.
\`timescale 1ns / 1ps

module tb_combinational;

  reg  a;
  reg  b;
  wire sum;
  wire carry;

  integer index;
  integer errors;

  combinational dut (
    .a(a),
    .b(b),
    .sum(sum),
    .carry(carry)
  );

  initial begin
    $display("tb_combinational: half adder check");
    errors = 0;

    for (index = 0; index < 4; index = index + 1) begin
      a = index[1];
      b = index[0];
      #1;

      if (sum !== index[1] ^ index[0] || carry !== index[1] & index[0]) begin
        errors = errors + 1;
        $display("  FAIL a=%b b=%b -> sum=%b carry=%b", a, b, sum, carry);
      end else begin
        $display("  ok   a=%b b=%b -> sum=%b carry=%b", a, b, sum, carry);
      end
    end

    if (errors == 0) begin
      $display("PASS combinational: 4 of 4 combinations matched");
    end else begin
      $display("FAIL combinational: %0d mismatches", errors);
    end

    $finish;
  end

endmodule
`;

export function createHdlTemplate(): HdlDocument {
  return {
    topModule: "tb_combinational",
    files: [
      { path: "rtl/combinational.v", language: "verilog", content: templateRtl },
      { path: "tb/tb_combinational.v", language: "testbench", content: templateTestbench },
    ],
  };
}

export function createFullAdderStarter(): HdlDocument {
  return {
    topModule: "tb_full_adder",
    files: [
      { path: "rtl/half_adder.v", language: "verilog", content: halfAdderRtl },
      { path: "rtl/full_adder.v", language: "verilog", content: fullAdderRtl },
      { path: "tb/tb_full_adder.v", language: "testbench", content: fullAdderTestbench },
    ],
  };
}

export function createCounterStarter(): HdlDocument {
  return {
    topModule: "tb_counter",
    files: [
      { path: "rtl/counter.v", language: "verilog", content: counterRtl },
      { path: "tb/tb_counter.v", language: "testbench", content: counterTestbench },
    ],
  };
}
