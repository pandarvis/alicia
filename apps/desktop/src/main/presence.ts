import type { ServerEvent } from "@alicia/protocol";
import type { ConnectionStatus } from "../shared/chat-connection.ts";
import { MASCOT_ON_ERROR, type MascotState } from "../shared/mascot.ts";

export interface PresencePorts {
  schedule(run: () => void, ms: number): () => void;
  onChange(mood: MascotState): void;
}

export const SUCCESS_MS = 1500;
export const TURN_ERROR_MS = 4000;
export const LISTENING_MS = 2500;
/** "veille" in the mascot brief: inactive for a while. */
export const SLEEP_AFTER_MS = 10 * 60_000;

/** Alicia's mood for the whole PC, from every window's turns and from the connection: what the Holo shows. */
export class Presence {
  readonly #ports: PresencePorts;
  #mood: MascotState = "idle";
  /** Messages sent and not finished yet (a refused second message must not end the first turn). */
  #turns = 0;
  #offline = false;
  #cancelTimer: (() => void) | null = null;

  constructor(ports: PresencePorts) {
    this.#ports = ports;
    this.#set("idle");
  }

  get mood(): MascotState {
    return this.#mood;
  }

  sent(): void {
    this.#turns++;
    this.#set("thinking");
  }

  event(event: ServerEvent): void {
    switch (event.type) {
      case "text_delta":
        if (this.#turns > 0) this.#set("speaking");
        return;
      case "tool_call":
        if (this.#turns > 0) this.#set(event.tool === "memory_remember" ? "idea" : "thinking");
        return;
      case "done":
        if (this.#turns === 0) return;
        this.#turns--;
        if (this.#turns === 0) this.#set("success", SUCCESS_MS);
        return;
      case "error":
        if (this.#turns === 0) return;
        this.#turns--;
        if (this.#turns === 0) this.#set(MASCOT_ON_ERROR[event.code] ?? "alert", TURN_ERROR_MS);
        return;
      case "heartbeat":
      case "ready":
      case "conversation":
      case "tool_result":
        return;
    }
  }

  status(status: ConnectionStatus): void {
    if (status === "ready") {
      this.#offline = false;
      if (this.#turns === 0) this.#set("idle");
      return;
    }
    if (status === "offline" || status === "rejected") {
      this.#turns = 0;
      this.#offline = true;
      this.#set(status === "rejected" ? "error" : "alert");
    }
  }

  /** Someone types to Alicia in one of the windows. */
  typing(): void {
    if (this.#turns > 0 || this.#offline) return;
    this.#set("listening", LISTENING_MS);
  }

  /** Sets the mood; with `resetAfterMs`, back to idle afterwards; idle falls asleep after a long quiet time. */
  #set(mood: MascotState, resetAfterMs?: number): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    if (mood !== this.#mood) {
      this.#mood = mood;
      this.#ports.onChange(mood);
    }
    if (resetAfterMs !== undefined) {
      this.#cancelTimer = this.#ports.schedule(() => {
        this.#cancelTimer = null;
        this.#set("idle");
      }, resetAfterMs);
    } else if (mood === "idle") {
      this.#cancelTimer = this.#ports.schedule(() => {
        this.#cancelTimer = null;
        this.#set("sleeping");
      }, SLEEP_AFTER_MS);
    }
  }
}
