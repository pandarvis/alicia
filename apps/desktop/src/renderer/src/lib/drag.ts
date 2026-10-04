import type { DragDelta } from "../../../shared/holo.ts";

export interface DragPorts {
  start(): void;
  /** Offset from the press point, in screen pixels. */
  move(delta: DragDelta): void;
  end(): void;
  click(): void;
}

/** A pointer event, reduced to what the tracker needs (screen coordinates). */
export interface PointerSample {
  x: number;
  y: number;
  pointerId: number;
}

/** Below this distance (px), a press is a click, not a drag. */
export const DRAG_THRESHOLD = 4;

/**
 * Tells a click from a drag on the Holo (screen coordinates, so the moving window does not matter). One
 * gesture at a time: only the pointer that pressed counts, and another pointer pressing during a gesture is
 * ignored.
 */
export class DragTracker {
  readonly #ports: DragPorts;
  #origin: PointerSample | null = null;
  #dragging = false;

  constructor(ports: DragPorts) {
    this.#ports = ports;
  }

  down(point: PointerSample): void {
    const origin = this.#origin;
    if (origin !== null) {
      if (origin.pointerId !== point.pointerId) return;
      // The same pointer cannot press twice: its release was lost (outside the window). End that gesture.
      this.cancel(point.pointerId);
    }
    this.#origin = point;
    this.#dragging = false;
  }

  move(point: PointerSample): void {
    const origin = this.#origin;
    if (origin?.pointerId !== point.pointerId) return;
    const delta = { dx: point.x - origin.x, dy: point.y - origin.y };
    if (!this.#dragging) {
      if (Math.hypot(delta.dx, delta.dy) < DRAG_THRESHOLD) return;
      this.#dragging = true;
      this.#ports.start();
    }
    this.#ports.move(delta);
  }

  up(point: PointerSample): void {
    if (this.#origin?.pointerId !== point.pointerId) return;
    this.move(point);
    const dragged = this.#dragging;
    this.#origin = null;
    this.#dragging = false;
    if (dragged) this.#ports.end();
    else this.#ports.click();
  }

  /** The pointer was lost (pointercancel, lost capture): a drag ends, a press is forgotten. */
  cancel(pointerId: number): void {
    if (this.#origin?.pointerId !== pointerId) return;
    const dragged = this.#dragging;
    this.#origin = null;
    this.#dragging = false;
    if (dragged) this.#ports.end();
  }
}
