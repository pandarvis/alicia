import type { BrainBridge } from "../../../shared/bridge.ts";
import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
import type { StoredSession } from "../../../shared/session.ts";
import { BrainApi } from "./brain-client.ts";
import { ChatStore } from "./chat-store.svelte.ts";
import { HubClient } from "./hub-client.ts";

function schedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => {
    clearTimeout(timer);
  };
}

/** The Holo's own conversation, over the main process's shared connection. */
export class MiniChat {
  status = $state<ConnectionStatus>("connecting");
  readonly store: ChatStore;
  readonly #hub: HubClient;
  readonly #bridge: BrainBridge;
  #offConversations: (() => void) | null = null;
  #wasOffline = false;

  constructor(session: StoredSession, bridge: BrainBridge, fetchFn: typeof fetch) {
    const api = new BrainApi(fetchFn, session);
    const hub = new HubClient(bridge, {
      onEvent: (event) => {
        this.store.handle(event);
      },
      onStatus: (status) => {
        this.#statusChanged(status);
      },
      onUndelivered: (requestId) => {
        this.store.undelivered(requestId);
      },
    });
    this.store = new ChatStore({
      listConversations: () => api.listConversations(),
      history: (id) => api.history(id),
      send: (message) => hub.send(message),
      confirm: (message) => hub.confirm(message),
      deleteConversation: (id) => api.deleteConversation(id),
      // The Holo offers no way to attach a file (v1: the main window does); wired all the same.
      upload: (file) => api.uploadAttachment(file, file.name),
      discardAttachment: (id) => api.discardAttachment(id),
      newId: () => crypto.randomUUID(),
      schedule,
    });
    this.#hub = hub;
    this.#bridge = bridge;
  }

  start(): void {
    this.#hub.start();
    // Another window's turn failed after creating its conversation.
    this.#offConversations ??= this.#bridge.onConversationsChanged(() => {
      void this.store.refreshConversations();
    });
  }

  stop(): void {
    this.#hub.stop();
    this.#offConversations?.();
    this.#offConversations = null;
  }

  #statusChanged(status: ConnectionStatus): void {
    this.status = status;
    if (status === "offline") {
      this.#wasOffline = true;
      this.store.connectionLost();
    } else if (status === "ready" && this.#wasOffline) {
      this.#wasOffline = false;
      // The brain may have finished the lost turn meanwhile.
      void this.store.resync();
    }
  }
}
