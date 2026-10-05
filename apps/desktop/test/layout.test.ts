import { describe, expect, test } from "vitest";
import {
  clampAnchor, defaultAnchor, exactAnchor, HOLO_SIZE, holoAnchor, type HoloLayout, holoLayout, nearestWorkArea, type PixelGrid,
  pixelExact, type Rect, spotlightBounds,
} from "../src/main/layout.ts";

const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };

/** Where the mascot's top-left corner lands on screen for a layout. */
function mascotOnScreen(layout: HoloLayout): { x: number; y: number } {
  const { bounds, mascot } = layout;
  return {
    x: mascot.edgeX === "left" ? bounds.x + mascot.x : bounds.x + bounds.width - mascot.x - HOLO_SIZE.width,
    y: mascot.edgeY === "top" ? bounds.y + mascot.y : bounds.y + bounds.height - mascot.y - HOLO_SIZE.height,
  };
}

/** A fractional-scale screen where only every 4th DIP falls on a pixel: elsewhere, the OS adds one pixel. */
const EVERY_4: PixelGrid = {
  toPhysical: (rect) => ({ ...rect, width: rect.width + (rect.x % 4 === 0 ? 0 : 1), height: rect.height + (rect.y % 4 === 0 ? 0 : 1) }),
  scaleOf: () => 1,
};

/** Windows at 150 %: physical edges rounded outwards (the left screen of a 1920 + 2560 px setup). */
const AT_150: PixelGrid = {
  toPhysical: (rect) => {
    const left = Math.floor(rect.x * 1.5);
    const top = Math.floor(rect.y * 1.5);
    return { x: left, y: top, width: Math.ceil((rect.x + rect.width) * 1.5) - left, height: Math.ceil((rect.y + rect.height) * 1.5) - top };
  },
  scaleOf: () => 1.5,
};

describe("pixel-exact windows", () => {
  const LEFT_SCREEN: Rect = { x: -1707, y: -93, width: 1707, height: 913 };

  test("without a grid (or already exact), nothing moves", () => {
    const rect = { x: -1707, y: 668, width: 136, height: 152 };
    expect(pixelExact(rect, LEFT_SCREEN, null)).toBe(rect);
    let asked = 0;
    const counting: PixelGrid = { ...AT_150, toPhysical: (r) => { asked++; return AT_150.toPhysical(r); } };
    const exact = { x: -1706, y: 668, width: 136, height: 152 };
    expect(pixelExact(exact, LEFT_SCREEN, counting)).toBe(exact);
    expect(asked).toBe(1);
  });

  test("against the left edge of a 150 % screen, the Holo moves one DIP in rather than growing a pixel", () => {
    expect(AT_150.toPhysical({ x: -1707, y: 668, width: 136, height: 152 }).width).toBe(205);
    expect(exactAnchor({ x: -1707, y: 668 }, LEFT_SCREEN, AT_150)).toEqual({ x: -1706, y: 668 });
    expect(AT_150.toPhysical({ x: -1706, y: 668, ...HOLO_SIZE })).toMatchObject({ width: 204, height: 228 });
    // Moved by an even number of DIP, it stays exact (no drift from move to move).
    expect(exactAnchor({ x: -1406, y: 468 }, LEFT_SCREEN, AT_150)).toEqual({ x: -1406, y: 468 });
  });

  test("never out of the work area, and the nearest place first", () => {
    expect(exactAnchor({ x: -137, y: 101 }, LEFT_SCREEN, AT_150)).toEqual({ x: -138, y: 100 });
    // Nothing better within reach: the place is kept.
    const stuck: PixelGrid = { toPhysical: (r) => ({ ...r, width: r.width + 1 }), scaleOf: () => 1 };
    expect(exactAnchor({ x: 10, y: 10 }, SCREEN, stuck)).toEqual({ x: 10, y: 10 });
  });
});

describe("Holo layout", () => {
  test("starts in the bottom-right corner, clear of the taskbar", () => {
    expect(defaultAnchor(SCREEN)).toEqual({ x: 1760, y: 864 });
  });

  test("stays on screen", () => {
    expect(clampAnchor({ x: -50, y: 2000 }, SCREEN)).toEqual({ x: 0, y: 1040 - HOLO_SIZE.height });
    expect(clampAnchor({ x: 1900.6, y: 10.2 }, SCREEN)).toEqual({ x: 1920 - HOLO_SIZE.width, y: 10 });
  });

  test("collapsed: just the mascot, placed from the edges the window will keep when it grows", () => {
    expect(holoLayout({ x: 1760, y: 864 }, false, SCREEN)).toEqual({
      bounds: { x: 1760, y: 864, width: 136, height: 152 },
      panelSide: "left",
      mascot: { edgeX: "right", x: 0, edgeY: "bottom", y: 0 },
    });
  });

  test("expanded: the mini-chat opens on the left and above, the mascot keeps the bottom-right corner", () => {
    expect(holoLayout({ x: 1760, y: 864 }, true, SCREEN)).toEqual({
      bounds: { x: 1432, y: 596, width: 464, height: 420 },
      panelSide: "left",
      mascot: { edgeX: "right", x: 0, edgeY: "bottom", y: 0 },
    });
  });

  test("near the left edge, the mini-chat opens on the right: the left edge stays put", () => {
    expect(holoLayout({ x: 100, y: 864 }, true, SCREEN)).toEqual({
      bounds: { x: 100, y: 596, width: 464, height: 420 },
      panelSide: "right",
      mascot: { edgeX: "left", x: 0, edgeY: "bottom", y: 0 },
    });
    expect(holoLayout({ x: 100, y: 864 }, false, SCREEN).mascot).toEqual({ edgeX: "left", x: 0, edgeY: "bottom", y: 0 });
  });

  test("near the top, the window grows downwards: the top edge stays put", () => {
    expect(holoLayout({ x: 1760, y: 50 }, true, SCREEN)).toMatchObject({
      bounds: { y: 50, height: 420 }, mascot: { edgeY: "top", y: 0 },
    });
    expect(holoLayout({ x: 1760, y: 50 }, false, SCREEN).mascot).toMatchObject({ edgeY: "top", y: 0 });
  });

  test("whenever the window can grow without being pushed back on screen, the mascot never moves", () => {
    for (const anchor of [{ x: 1760, y: 864 }, { x: 100, y: 864 }, { x: 1760, y: 50 }, { x: 500, y: 400 }]) {
      const collapsed = holoLayout(anchor, false, SCREEN);
      const expanded = holoLayout(anchor, true, SCREEN);
      expect(expanded.mascot, JSON.stringify(anchor)).toEqual(collapsed.mascot);
      expect(mascotOnScreen(expanded), JSON.stringify(anchor)).toEqual(anchor);
    }
  });

  test("on a screen too short for the mini-chat above or below, the mascot keeps its place on screen", () => {
    const short = { x: 0, y: 0, width: 1920, height: 500 };
    const layout = holoLayout({ x: 1760, y: 200 }, true, short);
    expect(layout.bounds).toMatchObject({ y: 80, height: 420 });
    expect(layout.mascot).toEqual({ edgeX: "right", x: 0, edgeY: "top", y: 120 });
    expect(mascotOnScreen(layout)).toEqual({ x: 1760, y: 200 });
  });

  test("on a short screen with a fractional scale, the expanded window is nudged to its exact size; the mascot stays", () => {
    const short = { x: 0, y: 2, width: 1920, height: 500 };
    const layout = holoLayout({ x: 1760, y: 200 }, true, short, EVERY_4);
    // Pushed back on screen to y = 82, between two pixels: nudged up to 80 (84 would leave the screen).
    expect(layout.bounds).toEqual({ x: 1432, y: 80, width: 464, height: 420 });
    expect(EVERY_4.toPhysical(layout.bounds)).toMatchObject({ width: 464, height: 420 });
    expect(mascotOnScreen(layout)).toEqual({ x: 1760, y: 200 });
  });

  test("with a fractional scale, the expanded window is only nudged where the mascot can follow it", () => {
    const anchor = { x: 1702, y: 866 };
    const layout = holoLayout(anchor, true, SCREEN, EVERY_4);
    // At 1374, 598, between two pixels: right and down (left or up would take the mascot along).
    expect(layout).toEqual({
      bounds: { x: 1376, y: 600, width: 464, height: 420 },
      panelSide: "left",
      mascot: { edgeX: "right", x: 2, edgeY: "bottom", y: 2 },
    });
    expect(EVERY_4.toPhysical(layout.bounds)).toMatchObject({ width: 464, height: 420 });
    expect(mascotOnScreen(layout)).toEqual(anchor);
  });

  test("against the edges of the screen, a nudge the mascot cannot follow is never taken: the window stays a pixel larger", () => {
    // Bottom-right corner: only left and up stay on screen. Top-left corner: only right and down.
    for (const [anchor, screen] of [
      [{ x: 1786, y: 890 }, { x: 0, y: 0, width: 1922, height: 1042 }],
      [{ x: 2, y: 2 }, { x: 2, y: 2, width: 1920, height: 1040 }],
    ] as const) {
      const plain = holoLayout(anchor, true, screen);
      const layout = holoLayout(anchor, true, screen, EVERY_4);
      expect(layout, JSON.stringify(anchor)).toEqual(plain);
      expect(mascotOnScreen(layout), JSON.stringify(anchor)).toEqual(anchor);
      expect(EVERY_4.toPhysical(layout.bounds)).toMatchObject({ width: 465, height: 421 });
    }
  });

  test("on a screen too narrow for either side, the expanded window stays on screen, beside the mascot", () => {
    const narrow = { x: 0, y: 0, width: 600, height: 1040 };
    expect(holoLayout({ x: 200, y: 864 }, true, narrow)).toEqual({
      bounds: { x: 136, y: 596, width: 464, height: 420 },
      panelSide: "right",
      mascot: { edgeX: "left", x: 0, edgeY: "bottom", y: 0 },
    });
  });

  test("on a second screen", () => {
    const right = { x: 1920, y: 0, width: 2560, height: 1400 };
    expect(holoLayout(defaultAnchor(right), false, right).bounds.x).toBeGreaterThan(1920);
  });
});

describe("Holo layout on several monitors", () => {
  const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 };

  test("on a monitor left of the main one (negative coordinates), expanded like anywhere else", () => {
    expect(defaultAnchor(LEFT)).toEqual({ x: -160, y: 864 });
    expect(holoLayout({ x: -160, y: 864 }, true, LEFT)).toEqual({
      bounds: { x: -488, y: 596, width: 464, height: 420 },
      panelSide: "left",
      mascot: { edgeX: "right", x: 0, edgeY: "bottom", y: 0 },
    });
    expect(holoLayout({ x: -1900, y: 864 }, true, LEFT)).toMatchObject({ bounds: { x: -1900 }, panelSide: "right" });
  });

  test("the work area of a point: the monitor it is on, else the nearest one", () => {
    expect(nearestWorkArea({ x: -500, y: 300 }, [SCREEN, LEFT], SCREEN)).toBe(LEFT);
    expect(nearestWorkArea({ x: 2500, y: 300 }, [SCREEN, LEFT], SCREEN)).toBe(SCREEN);
    expect(nearestWorkArea({ x: 0, y: 0 }, [], SCREEN)).toBe(SCREEN);
  });

  test("a saved place on a monitor that is gone comes back onto the nearest one", () => {
    expect(holoAnchor({ x: 3000, y: 200 }, [SCREEN], SCREEN)).toEqual({ x: 1920 - HOLO_SIZE.width, y: 200 });
    expect(holoAnchor({ x: -400, y: 300 }, [SCREEN, LEFT], SCREEN)).toEqual({ x: -400, y: 300 });
    expect(holoAnchor(null, [SCREEN, LEFT], SCREEN)).toEqual(defaultAnchor(SCREEN));
  });
});

describe("spotlightBounds", () => {
  test("centred, a little above the middle of the screen", () => {
    expect(spotlightBounds(SCREEN)).toEqual({ x: 620, y: 229, width: 680, height: 120 });
  });

  test("narrower than the screen it is on, with a margin", () => {
    expect(spotlightBounds({ x: 100, y: 0, width: 600, height: 800 })).toEqual({ x: 116, y: 176, width: 568, height: 120 });
  });
});
