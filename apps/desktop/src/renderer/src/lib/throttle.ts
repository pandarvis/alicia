/** Runs `run` at once, then at most once per `intervalMs` (later calls in between are dropped). */
export function throttle(run: () => void, intervalMs: number, now: () => number = Date.now): () => void {
  let last = -Infinity;
  return () => {
    const time = now();
    if (time - last < intervalMs) return;
    last = time;
    run();
  };
}

/** How often typing is reported to the main process (Alicia's "listening" mood needs no more). */
export const TYPING_INTERVAL_MS = 300;
