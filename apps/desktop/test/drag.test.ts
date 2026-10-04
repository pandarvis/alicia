import { describe, expect, test } from "vitest";
import { DragTracker } from "../src/renderer/src/lib/drag.ts";

function setup() {
  const calls: string[] = [];
  const tracker = new DragTracker({
    start: () => { calls.push("start"); },
    move: ({ dx, dy }) => { calls.push(`move ${dx},${dy}`); },
    end: () => { calls.push("end"); },
    click: () => { calls.push("click"); },
  });
  return { tracker, calls };
}

describe("DragTracker", () => {
  test("a press without moving is a click", () => {
    const { tracker, calls } = setup();
    tracker.down({ x: 10, y: 10 });
    tracker.up({ x: 10, y: 10 });
    expect(calls).toEqual(["click"]);
  });

  test("a tiny wobble is still a click", () => {
    const { tracker, calls } = setup();
    tracker.down({ x: 10, y: 10 });
    tracker.move({ x: 12, y: 11 });
    tracker.up({ x: 12, y: 11 });
    expect(calls).toEqual(["click"]);
  });

  test("beyond the threshold: one start, offsets from the press point, one end, no click", () => {
    const { tracker, calls } = setup();
    tracker.down({ x: 10, y: 10 });
    tracker.move({ x: 20, y: 10 });
    tracker.move({ x: 40, y: -5 });
    tracker.up({ x: 40, y: -5 });
    expect(calls).toEqual(["start", "move 10,0", "move 30,-15", "move 30,-15", "end"]);
  });

  test("cancel ends a drag without a click; moves without a press are ignored", () => {
    const { tracker, calls } = setup();
    tracker.move({ x: 50, y: 50 });
    tracker.down({ x: 0, y: 0 });
    tracker.move({ x: 0, y: 20 });
    tracker.cancel();
    tracker.up({ x: 0, y: 20 });
    expect(calls).toEqual(["start", "move 0,20", "end"]);
  });
});
