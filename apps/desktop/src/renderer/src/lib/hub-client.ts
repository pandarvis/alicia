import type { ConfirmMessage, SendMessage, ServerEvent } from "@alicia/protocol";
import type { BrainBridge } from "../../../shared/bridge.ts";
import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
import { mirror } from "./mirror.ts";

export interface HubClientHandlers {
  onEvent(event: ServerEvent): void;
  onStatus(status: ConnectionStatus): void;
  /** A message the window believed sent did not reach the brain after all. */
  onUndelivered(requestId: string): void;
}

/** A window's view of the main process's brain connection; `send` stays synchronous like ChatConnection's. */
export class HubClient {
  readonly #bridge: BrainBridge;
  readonly #handlers: HubClientHandlers;
  #status: ConnectionStatus = "connecting";
  readonly #offs: (() => void)[] = [];
  #stopped = false;

  constructor(bridge: BrainBridge, handlers: HubClientHandlers) {
    this.#bridge = bridge;
    this.#handlers = handlers;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  start(): void {
    this.#stopped = false;
    this.#offs.push(
      this.#bridge.onEvent((event) => {
        this.#handlers.onEvent(event);
      }),
      mirror(
        () => this.#bridge.status(),
        (listener) => this.#bridge.onStatus(listener),
        (status) => {
          if (this.#stopped) return;
          this.#status = status;
          this.#handlers.onStatus(status);
        },
      ),
    );
  }

  stop(): void {
    this.#stopped = true;
    for (const off of this.#offs.splice(0)) off();
  }

  /** False when the connection is not ready; a refusal by the main process arrives later as `onUndelivered`. */
  send(message: SendMessage): boolean {
    if (this.#stopped || this.#status !== "ready") return false;
    this.#bridge.send(message).then(
      (delivered) => {
        if (!delivered && !this.#stopped) this.#handlers.onUndelivered(message.requestId);
      },
      () => {
        if (!this.#stopped) this.#handlers.onUndelivered(message.requestId);
      },
    );
    return true;
  }

  /** The answer to a confirmation card; false when not ready, or when the main process could not hand it over. */
  async confirm(message: ConfirmMessage): Promise<boolean> {
    if (this.#stopped || this.#status !== "ready") return false;
    try {
      return await this.#bridge.confirm(message);
    } catch {
      return false;
    }
  }
}
