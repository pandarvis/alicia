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

  constructor(options: ChatConnectionOptions) {
    this.#options = options;
  }

  start(): void {
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
    this.#socket?.close(NORMAL_CLOSURE);
  }

  #open(): void {
    this.#ready = false;
    this.#options.onStatus("connecting");
    const socket = this.#options.openSocket(this.#options.url);
    this.#socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "authenticate", token: this.#options.token }));
    };
    socket.onmessage = (data) => {
      this.#receive(data);
    };
    socket.onclose = (code) => {
      this.#closed(code);
    };
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
      this.#ready = true;
      this.#attempt = 0;
      this.#options.onStatus("ready");
    }
    this.#options.onEvent(parsed.data);
  }

  #closed(code: number): void {
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
      this.#open();
    }, delay);
  }
}
