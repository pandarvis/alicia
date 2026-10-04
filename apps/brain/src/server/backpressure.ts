import { setTimeout as sleep } from "node:timers/promises";

/** What waitForDrain needs from a WebSocket. */
export interface BufferedSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  readonly OPEN: number;
}

export interface DrainOptions {
  /** Above this many queued bytes, the sender waits. */
  highWaterBytes: number;
  /** Gives up after waiting this long. */
  timeoutMs: number;
  /** Polling period while waiting. */
  pollMs: number;
  /** Injected by tests. */
  wait: (ms: number) => Promise<void>;
}

/** 256 KiB is hundreds of text deltas: only an app that stopped reading gets there. */
export const DEFAULT_DRAIN: DrainOptions = {
  highWaterBytes: 262_144,
  timeoutMs: 30_000,
  pollMs: 50,
  wait: (ms) => sleep(ms),
};

/**
 * Waits until the socket's send buffer is back under the high-water mark (immediately in the usual case).
 * False if the socket is no longer open or did not drain in time: the caller stops sending.
 */
export async function waitForDrain(socket: BufferedSocket, options: DrainOptions): Promise<boolean> {
  let waited = 0;
  while (socket.bufferedAmount > options.highWaterBytes) {
    if (socket.readyState !== socket.OPEN || waited >= options.timeoutMs) return false;
    await options.wait(options.pollMs);
    waited += options.pollMs;
  }
  return socket.readyState === socket.OPEN;
}
