import type { ServerEvent } from "@alicia/protocol";
import type { ConnectionStatus } from "../shared/chat-connection.ts";
import { MASCOT_ON_ERROR, type MascotState } from "../shared/mascot.ts";
import type { FinishedTurn } from "./brain-hub.ts";

export interface PresencePorts {
  schedule(run: () => void, ms: number): () => void;
  onChange(mood: MascotState): void;
}

export const SUCCESS_MS = 1500;
export const TURN_ERROR_MS = 4000;
export const LISTENING_MS = 2500;
/** "veille" in the mascot brief: inactive for a while. */
export const SLEEP_AFTER_MS = 10 * 60_000;

/**
 * Alicia's mood for the whole PC, from every window's turns and from the connection: what the Holo shows.
 * Which turns are running is the BrainHub's to say (`sent` and `finished` carry its count).
 */
export class Presence {
  readonly #ports: PresencePorts;
  #mood: MascotState = "idle";
  /** A turn is running somewhere (as counted by the hub). */
  #running = false;
  /** The connection is down or the device refused: her mood is the connection's. */
  #offline = false;
  /** Out of quota: asleep until a turn succeeds again. */
  #exhausted = false;
  #cancelTimer: (() => void) | null = null;

  constructor(ports: PresencePorts) {
    this.#ports = ports;
    this.#set("idle");
  }

  get mood(): MascotState {
    return this.#mood;
  }

  /** A message left for the brain; `pendingTurns` includes it. */
  sent(pendingTurns: number): void {
    const wasRunning = this.#running;
    this.#running = pendingTurns > 0;
    // A second message while she answers does not interrupt her.
    if (!wasRunning) this.#set("thinking");
  }

  /** What she does during a turn (its end comes through `finished`). */
  event(event: ServerEvent): void {
    if (!this.#running) return;
    if (event.type === "text_delta") this.#set("speaking");
    else if (event.type === "tool_call") this.#set(event.tool === "memory_remember" ? "idea" : "thinking");
  }

  /** A turn ended; `pendingTurns`: those still running (a refused second message leaves the first one going). */
  finished(turn: FinishedTurn, pendingTurns: number): void {
    this.#running = pendingTurns > 0;
    if (this.#running || this.#offline) return;
    if (turn.outcome === "answered") {
      this.#exhausted = false;
      this.#set("success", SUCCESS_MS);
      return;
    }
    if (turn.code === "quota") {
      this.#exhausted = true;
      this.#set("sleeping", null);
      return;
    }
    this.#set((turn.code === undefined ? undefined : MASCOT_ON_ERROR[turn.code]) ?? "alert", TURN_ERROR_MS);
  }

  status(status: ConnectionStatus): void {
    if (status === "ready") {
      // Only the connection's own mood (alert or error while offline) ends here: a sleeping (quota) Alicia
      // stays asleep, and a success or an error shown for a moment keeps its timer.
      const wasOffline = this.#offline;
      this.#offline = false;
      if (wasOffline && !this.#running) this.#set(this.#exhausted ? "sleeping" : "idle", this.#exhausted ? null : undefined);
      return;
    }
    if (status === "offline" || status === "rejected") {
      this.#running = false;
      this.#offline = true;
      this.#set(status === "rejected" ? "error" : "alert", null);
    }
  }

  /** Signed out on purpose: nothing is wrong, she simply waits. */
  signedOut(): void {
    this.#running = false;
    this.#offline = false;
    this.#exhausted = false;
    this.#set("idle");
  }

  /** Someone types to Alicia in one of the windows. */
  typing(): void {
    if (this.#running || this.#offline || this.#exhausted) return;
    this.#set("listening", LISTENING_MS);
  }

  /**
   * Sets the mood. `resetAfterMs`: back to idle afterwards; null: stays as is; omitted: idle falls asleep after
   * a long quiet time.
   */
  #set(mood: MascotState, resetAfterMs?: number | null): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    if (mood !== this.#mood) {
      this.#mood = mood;
      this.#ports.onChange(mood);
    }
    if (typeof resetAfterMs === "number") {
      this.#cancelTimer = this.#ports.schedule(() => {
        this.#cancelTimer = null;
        this.#set("idle");
      }, resetAfterMs);
    } else if (resetAfterMs === undefined && mood === "idle") {
      this.#cancelTimer = this.#ports.schedule(() => {
        this.#cancelTimer = null;
        this.#set("sleeping");
      }, SLEEP_AFTER_MS);
    }
  }
}
