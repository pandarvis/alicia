import { z } from "zod";

const coordinate = z.number().int().min(-100_000).max(100_000);

/** A point on the desktop, in Electron screen coordinates (DIP). */
export const Point = z.object({ x: coordinate, y: coordinate });
export type Point = z.infer<typeof Point>;

/** How far the pointer moved since a Holo drag started (screen DIP). Zod 4 numbers already refuse NaN and infinities. */
export const DragDelta = z.object({
  dx: z.number().min(-100_000).max(100_000),
  dy: z.number().min(-100_000).max(100_000),
});
export type DragDelta = z.infer<typeof DragDelta>;

export const PanelSide = z.enum(["left", "right"]);
export type PanelSide = z.infer<typeof PanelSide>;

/**
 * Where the mascot sits in the Holo window, measured from the window edges that stay put when it grows or
 * shrinks: the page and the window resize at different moments, and the mascot must never jump in between.
 */
export const MascotPlacement = z.object({
  edgeX: z.enum(["left", "right"]),
  x: coordinate,
  edgeY: z.enum(["top", "bottom"]),
  y: coordinate,
});
export type MascotPlacement = z.infer<typeof MascotPlacement>;

/** What the Holo page needs to lay itself out: mini-chat open or not, on which side, where the mascot sits. */
export const HoloView = z.object({ expanded: z.boolean(), panelSide: PanelSide, mascot: MascotPlacement });
export type HoloView = z.infer<typeof HoloView>;
