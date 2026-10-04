import { describe, expect, test } from "vitest";
import { DragTracker, type PointerSample } from "../src/renderer/src/lib/drag.ts";

function at(x: number, y: number, pointerId = 1): PointerSample {
  return { x, y, pointerId };
}

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
    tracker.down(at(10, 10));
    tracker.up(at(10, 10));
    expect(calls).toEqual(["click"]);
  });

  test("a tiny wobble is still a click", () => {
    const { tracker, calls } = setup();
    tracker.down(at(10, 10));
    tracker.move(at(12, 11));
    tracker.up(at(12, 11));
    expect(calls).toEqual(["click"]);
  });

  test("beyond the threshold: one start, offsets from the press point, one end, no click", () => {
    const { tracker, calls } = setup();
    tracker.down(at(10, 10));
    tracker.move(at(20, 10));
    tracker.move(at(40, -5));
    tracker.up(at(40, -5));
    expect(calls).toEqual(["start", "move 10,0", "move 30,-15", "move 30,-15", "end"]);
  });

  test("cancel ends a drag without a click; moves without a press are ignored", () => {
    const { tracker, calls } = setup();
    tracker.move(at(50, 50));
    tracker.down(at(0, 0));
    tracker.move(at(0, 20));
    tracker.cancel(1);
    tracker.up(at(0, 20));
    expect(calls).toEqual(["start", "move 0,20", "end"]);
  });

  test("only the pointer that pressed drives the gesture", () => {
    const { tracker, calls } = setup();
    tracker.down(at(0, 0, 1));
    tracker.move(at(0, 30, 2));
    tracker.up(at(0, 30, 2));
    tracker.cancel(2);
    expect(calls).toEqual([]);
    tracker.up(at(0, 0, 1));
    expect(calls).toEqual(["click"]);
  });

  test("another pointer pressing during a drag is ignored: the drag goes on from its own start", () => {
    const { tracker, calls } = setup();
    tracker.down(at(0, 0, 1));
    tracker.move(at(10, 0, 1));
    tracker.down(at(100, 100, 2));
    tracker.move(at(20, 0, 1));
    tracker.up(at(20, 0, 1));
    expect(calls).toEqual(["start", "move 10,0", "move 20,0", "move 20,0", "end"]);
  });

  test("the same pointer pressing again means its release was lost: that drag ends, a new gesture starts", () => {
    const { tracker, calls } = setup();
    tracker.down(at(0, 0, 1));
    tracker.move(at(10, 0, 1));
    tracker.down(at(100, 100, 1));
    tracker.up(at(100, 100, 1));
    expect(calls).toEqual(["start", "move 10,0", "end", "click"]);
  });
});
