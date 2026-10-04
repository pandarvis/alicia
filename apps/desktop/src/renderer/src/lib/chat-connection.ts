import { type SendMessage, ServerEvent } from "@alicia/protocol";

export type ConnectionStatus = "connecting" | "ready" | "offline" | "rejected";

/** The few WebSocket features we use, so tests can drive a fake. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
}

export interface ChatConnectionOptions {
  url: string;
  token: string;
  openSocket: (url: string) => SocketLike;
  /** Runs `run` after `ms`; returns a cancel function. */
  schedule: (run: () => void, ms: number) => () => void;
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
}

const DEVICE_REFUSED = 4401;
const NORMAL_CLOSURE = 1000;
const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_CLOSE = 4000;

/** Adapter from the browser WebSocket to SocketLike. */
export function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    send: (data) => {
      ws.send(data);
    },
    close: (code) => {
      ws.close(code);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => {
    if (typeof event.data === "string") socket.onmessage?.(event.data);
  };
  ws.onclose = (event) => socket.onclose?.(event.code);
  return socket;
}

export class ChatConnection {
  readonly #options: ChatConnectionOptions;
  #socket: SocketLike | null = null;
  #ready = false;
  #attempt = 0;
  #stopped = false;
  #cancelRetry: (() => void) | null = null;
  #cancelReadyTimeout: (() => void) | null = null;

  constructor(options: ChatConnectionOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#socket !== null) return;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#stopped = false;
    this.#open();
  }

  send(message: SendMessage): boolean {
    if (!this.#ready || this.#socket === null) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#clearReadyTimeout();
    const socket = this.#socket;
    this.#ready = false;
    this.#socket = null;
    socket?.close(NORMAL_CLOSURE);
  }

  #open(): void {
    this.#ready = false;
    this.#options.onStatus("connecting");
    const socket = this.#options.openSocket(this.#options.url);
    this.#socket = socket;
    this.#cancelReadyTimeout = this.#options.schedule(() => {
      this.#cancelReadyTimeout = null;
      if (this.#socket === socket && !this.#ready) socket.close(READY_TIMEOUT_CLOSE);
    }, READY_TIMEOUT_MS);
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      socket.send(JSON.stringify({ type: "authenticate", token: this.#options.token }));
    };
    socket.onmessage = (data) => {
      if (this.#socket !== socket) return;
      this.#receive(data);
    };
    socket.onclose = (code) => {
      if (this.#socket !== socket) return;
      this.#closed(code);
    };
  }

  #clearReadyTimeout(): void {
    this.#cancelReadyTimeout?.();
    this.#cancelReadyTimeout = null;
  }

  #receive(data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerEvent.safeParse(json);
    if (!parsed.success) return;
    if (parsed.data.type === "ready") {
      this.#clearReadyTimeout();
      this.#ready = true;
      this.#attempt = 0;
      this.#options.onStatus("ready");
    }
    try {
      this.#options.onEvent(parsed.data);
    } catch {
      // A faulty consumer must not break the connection; log the type only.
      console.error(`chat event handler failed (${parsed.data.type})`);
    }
  }

  #closed(code: number): void {
    this.#clearReadyTimeout();
    this.#ready = false;
    this.#socket = null;
    if (this.#stopped) return;
    if (code === DEVICE_REFUSED) {
      this.#options.onStatus("rejected");
      return;
    }
    this.#options.onStatus("offline");
    const delay = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** this.#attempt);
    this.#attempt++;
    this.#cancelRetry = this.#options.schedule(() => {
      this.#cancelRetry = null;
      if (this.#stopped || this.#socket !== null) return;
      this.#open();
    }, delay);
  }
}
