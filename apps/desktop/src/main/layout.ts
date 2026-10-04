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
 * on screen and the mascot moves with it, still beside its mini-chat.
 */
export function holoLayout(anchor: Point, expanded: boolean, workArea: Rect): HoloLayout {
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
  // Sideways the mascot stays against its edge, beside the mini-chat; vertically it keeps its height on screen.
  const top = anchor.y - y;
  return {
    bounds: { x, y, width, height },
    panelSide,
    mascot: { edgeX, x: 0, edgeY, y: edgeY === "top" ? top : height - top - HOLO_SIZE.height },
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
