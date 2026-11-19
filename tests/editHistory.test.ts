import { describe, expect, it } from "vitest";
import { maxHistoryDepth, pushFuture, pushPast, redoStep, undoStep } from "../src/lib/editHistory";

describe("pushPast", () => {
  it("appends the current value and caps the depth", () => {
    let past: number[] = [];
    for (let index = 0; index < maxHistoryDepth + 10; index += 1) {
      past = pushPast(past, index);
    }

    expect(past).toHaveLength(maxHistoryDepth);
    expect(past[past.length - 1]).toBe(maxHistoryDepth + 9);
    expect(past[0]).toBe(10);
  });
});

describe("pushFuture", () => {
  it("prepends the current value so the newest redo comes first", () => {
    expect(pushFuture([3, 4], 2)).toEqual([2, 3, 4]);
  });

  it("caps the depth", () => {
    let future: number[] = [];
    for (let index = 0; index < maxHistoryDepth + 5; index += 1) {
      future = pushFuture(future, index);
    }

    expect(future).toHaveLength(maxHistoryDepth);
    expect(future[0]).toBe(maxHistoryDepth + 4);
  });
});

describe("undoStep / redoStep", () => {
  it("returns null when there is nothing to move to", () => {
    expect(undoStep([], [], "current")).toBeNull();
    expect(redoStep([], [], "current")).toBeNull();
  });

  it("moves the present back to the newest past entry and forwards the old present", () => {
    const step = undoStep(["a", "b"], ["d"], "c");
    expect(step).toEqual({ past: ["a"], present: "b", future: ["c", "d"] });
  });

  it("moves the present forward to the newest future entry", () => {
    const step = redoStep(["a"], ["c", "d"], "b");
    expect(step).toEqual({ past: ["a", "b"], present: "c", future: ["d"] });
  });

  it("round-trips a commit through undo then redo", () => {
    const past = pushPast([], "A");
    expect({ past, present: "B" }).toEqual({ past: ["A"], present: "B" });

    const undone = undoStep(past, [], "B");
    expect(undone).toEqual({ past: [], present: "A", future: ["B"] });

    if (!undone) {
      throw new Error("expected an undo step");
    }

    const redone = redoStep(undone.past, undone.future, undone.present);
    expect(redone).toEqual({ past: ["A"], present: "B", future: [] });
  });
});
