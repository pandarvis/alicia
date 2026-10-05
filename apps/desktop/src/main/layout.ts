import type { MascotPlacement, PanelSide, Point } from "../shared/holo.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The collapsed Holo window: the 120 px mascot with room around it. */
export const HOLO_SIZE = { width: 136, height: 152 } as const;
/** The mini-chat beside the mascot. */
export const HOLO_PANEL = { width: 320, height: 420, gap: 8 } as const;
export const SPOTLIGHT_SIZE = { width: 680, height: 120 } as const;
const MARGIN = 24;
/** Space kept on each side of the Spotlight bar on a narrow screen. */
const SPOTLIGHT_MARGIN = 16;

export interface HoloLayout {
  bounds: Rect;
  panelSide: PanelSide;
  /** Where the collapsed box (the mascot) sits inside the window, from the edges that stay put. */
  mascot: MascotPlacement;
}

/** Bottom-right corner of the work area (above the taskbar). */
export function defaultAnchor(workArea: Rect): Point {
  return {
    x: workArea.x + workArea.width - HOLO_SIZE.width - MARGIN,
    y: workArea.y + workArea.height - HOLO_SIZE.height - MARGIN,
  };
}

/** Keeps the collapsed Holo fully inside the work area. */
export function clampAnchor(anchor: Point, workArea: Rect): Point {
  return {
    x: Math.round(Math.min(Math.max(anchor.x, workArea.x), workArea.x + workArea.width - HOLO_SIZE.width)),
    y: Math.round(Math.min(Math.max(anchor.y, workArea.y), workArea.y + workArea.height - HOLO_SIZE.height)),
  };
}

/** Squared distance from a point to a rectangle (0 inside). */
function distanceSquared(point: Point, area: Rect): number {
  const dx = Math.max(area.x - point.x, 0, point.x - (area.x + area.width));
  const dy = Math.max(area.y - point.y, 0, point.y - (area.y + area.height));
  return dx * dx + dy * dy;
}

/** The work area a point is on, else the nearest one (a monitor may have been unplugged); `primary` when none. */
export function nearestWorkArea(point: Point, areas: readonly Rect[], primary: Rect): Rect {
  let best = primary;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const area of areas) {
    const distance = distanceSquared(point, area);
    if (distance < bestDistance) {
      best = area;
      bestDistance = distance;
    }
  }
  return best;
}

/** Where the collapsed Holo goes: its saved place, brought back onto a monitor that still exists, or the default. */
export function holoAnchor(saved: Point | null, areas: readonly Rect[], primary: Rect): Point {
  if (saved === null) return defaultAnchor(primary);
  return clampAnchor(saved, nearestWorkArea(saved, areas, primary));
}

/**
 * How the OS turns a window's rectangle (DIP) into physical pixels. Only Windows needs it: on a screen with a
 * fractional scale (150 %…), a rectangle whose edges fall between two pixels is rounded outwards, one pixel too big.
 */
export interface PixelGrid {
  toPhysical(rect: Rect): Rect;
  /** The scale of the screen the rectangle is on. */
  scaleOf(rect: Rect): number;
}

const MAX_NUDGE = 3;
/** Offsets tried around a rectangle, nearest first (a 125 % or 175 % screen repeats every 4 DIP). */
const NUDGES: readonly Point[] = (() => {
  const offsets: Point[] = [];
  for (let x = -MAX_NUDGE; x <= MAX_NUDGE; x++) for (let y = -MAX_NUDGE; y <= MAX_NUDGE; y++) offsets.push({ x, y });
  return offsets.sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - (Math.abs(b.x) + Math.abs(b.y)));
})();

function inside(rect: Rect, area: Rect): boolean {
  return rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height;
}

/**
 * The rectangle, moved by at most a few DIP (never out of `within`, and only to places `allowed` accepts) so that
 * the OS gives it exactly its size in physical pixels: the window keeps its canonical size wherever it goes, instead
 * of growing by a pixel on some places of a fractional-scale screen. Unchanged when it is already exact, when no
 * allowed place nearby is better, or without a grid.
 */
export function pixelExact(
  rect: Rect, within: Rect, grid: PixelGrid | null, allowed: (candidate: Rect) => boolean = () => true,
): Rect {
  if (grid === null) return rect;
  const scale = grid.scaleOf(rect);
  const width = Math.round(rect.width * scale);
  const height = Math.round(rect.height * scale);
  const misses = (candidate: Rect): number => {
    const physical = grid.toPhysical(candidate);
    return (physical.width === width ? 0 : 1) + (physical.height === height ? 0 : 1);
  };
  let best = rect;
  let bestMisses = misses(rect);
  for (const nudge of NUDGES) {
    if (bestMisses === 0) break;
    const candidate = { ...rect, x: rect.x + nudge.x, y: rect.y + nudge.y };
    if (!inside(candidate, within) || !allowed(candidate)) continue;
    const candidateMisses = misses(candidate);
    if (candidateMisses < bestMisses) {
      best = candidate;
      bestMisses = candidateMisses;
    }
  }
  return best;
}

/** The collapsed Holo's place, nudged so that its window has exactly its size (see pixelExact). */
export function exactAnchor(anchor: Point, workArea: Rect, grid: PixelGrid | null): Point {
  const exact = pixelExact({ ...anchor, ...HOLO_SIZE }, workArea, grid);
  return { x: exact.x, y: exact.y };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

const EXPANDED_WIDTH = HOLO_SIZE.width + HOLO_PANEL.gap + HOLO_PANEL.width;
const EXPANDED_HEIGHT = Math.max(HOLO_SIZE.height, HOLO_PANEL.height);

/**
 * The Holo window for a mascot at `anchor`. Expanded, the window grows towards the side with room (left first)
 * and upwards (downwards near the top of the screen), so the mascot stays exactly where it is on screen. The
 * mascot is placed from the edges that stay put — in both states, so that whichever of the window and the page
 * changes first, it does not move. On a screen too narrow for the mini-chat on either side, the window is kept
 * on screen and the mascot moves with it, still beside its mini-chat. With a grid, the expanded window is nudged to
 * its exact size in pixels (pixelExact), only in directions the mascot's place inside the window can make up for: the
 * mascot never moves (against an edge of the screen, the window may stay a pixel larger instead).
 */
export function holoLayout(anchor: Point, expanded: boolean, workArea: Rect, grid: PixelGrid | null = null): HoloLayout {
  const panelSide: PanelSide = anchor.x - workArea.x >= HOLO_PANEL.width + HOLO_PANEL.gap ? "left" : "right";
  const growsUp = anchor.y + HOLO_SIZE.height - EXPANDED_HEIGHT >= workArea.y;
  const edgeX = panelSide === "left" ? "right" : "left";
  const edgeY = growsUp ? "bottom" : "top";
  if (!expanded) return { bounds: { ...anchor, ...HOLO_SIZE }, panelSide, mascot: { edgeX, x: 0, edgeY, y: 0 } };
  const width = EXPANDED_WIDTH;
  const height = EXPANDED_HEIGHT;
  const x = clamp(
    panelSide === "left" ? anchor.x + HOLO_SIZE.width - width : anchor.x,
    workArea.x,
    workArea.x + workArea.width - width,
  );
  const y = clamp(growsUp ? anchor.y + HOLO_SIZE.height - height : anchor.y, workArea.y, workArea.y + workArea.height - height);
  // Sideways the mascot stays against its edge, beside the mini-chat (or as far in as the window was nudged out);
  // vertically it keeps its height on screen. A window nudged the other way would leave it no place inside.
  const place = (frame: Rect): Point => ({ x: edgeX === "left" ? x - frame.x : frame.x - x, y: anchor.y - frame.y });
  const roomX = width - HOLO_SIZE.width;
  const roomY = height - HOLO_SIZE.height;
  const bounds = pixelExact({ x, y, width, height }, workArea, grid, (candidate) => {
    const at = place(candidate);
    return at.x >= 0 && at.x <= roomX && at.y >= 0 && at.y <= roomY;
  });
  const at = place(bounds);
  // Always inside the window, whatever the screen: a mascot cut by its own window would be worse than one moved.
  const top = clamp(at.y, 0, roomY);
  return {
    bounds,
    panelSide,
    mascot: { edgeX, x: clamp(at.x, 0, roomX), edgeY, y: edgeY === "top" ? top : roomY - top },
  };
}

/** The Spotlight bar: centred, a little above the middle of the screen under the pointer. */
export function spotlightBounds(workArea: Rect): Rect {
  const width = Math.max(0, Math.min(SPOTLIGHT_SIZE.width, workArea.width - 2 * SPOTLIGHT_MARGIN));
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round(workArea.height * 0.22),
    width,
    height: SPOTLIGHT_SIZE.height,
  };
}
