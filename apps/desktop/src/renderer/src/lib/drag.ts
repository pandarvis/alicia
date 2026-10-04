import type { DragDelta } from "../../../shared/holo.ts";

export interface DragPorts {
  start(): void;
  /** Offset from the press point, in screen pixels. */
  move(delta: DragDelta): void;
  end(): void;
  click(): void;
}

/** Below this distance (px), a press is a click, not a drag. */
export const DRAG_THRESHOLD = 4;

/** Tells a click from a drag on the Holo (screen coordinates, so the moving window does not matter). */
export class DragTracker {
  readonly #ports: DragPorts;
  #origin: { x: number; y: number } | null = null;
  #dragging = false;

  constructor(ports: DragPorts) {
    this.#ports = ports;
  }

  down(point: { x: number; y: number }): void {
    this.#origin = point;
    this.#dragging = false;
  }

  move(point: { x: number; y: number }): void {
    const origin = this.#origin;
    if (origin === null) return;
    const delta = { dx: point.x - origin.x, dy: point.y - origin.y };
    if (!this.#dragging) {
      if (Math.hypot(delta.dx, delta.dy) < DRAG_THRESHOLD) return;
      this.#dragging = true;
      this.#ports.start();
    }
    this.#ports.move(delta);
  }

  up(point: { x: number; y: number }): void {
    if (this.#origin === null) return;
    this.move(point);
    const dragged = this.#dragging;
    this.#origin = null;
    this.#dragging = false;
    if (dragged) this.#ports.end();
    else this.#ports.click();
  }

  cancel(): void {
    const dragged = this.#dragging;
    this.#origin = null;
    this.#dragging = false;
    if (dragged) this.#ports.end();
  }
}
