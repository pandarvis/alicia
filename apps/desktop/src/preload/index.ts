import { ServerEvent } from "@alicia/protocol";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { z } from "zod";
import { type AliciaBridge, INVOKE, PUSH } from "../shared/bridge.ts";
import { ConnectionStatus } from "../shared/chat-connection.ts";
import { MascotState } from "../shared/mascot.ts";
import { SaveSessionResult, StoredSession } from "../shared/session.ts";

/** Listens to a main-process push; anything that does not match the schema is dropped. */
function subscribe<T>(channel: string, schema: z.ZodType<T>, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, raw: unknown): void => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) listener(parsed.data);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/** Calls the main process and validates its answer (throws when it does not match). */
async function call<T>(schema: z.ZodType<T>, channel: string, ...args: unknown[]): Promise<T> {
  const raw: unknown = await ipcRenderer.invoke(channel, ...args);
  return schema.parse(raw);
}

const bridge: AliciaBridge = {
  async getSession() {
    const raw: unknown = await ipcRenderer.invoke(INVOKE.getSession);
    const parsed = StoredSession.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  async saveSession(session) {
    const raw: unknown = await ipcRenderer.invoke(INVOKE.saveSession, session);
    const parsed = SaveSessionResult.safeParse(raw);
    return parsed.success ? parsed.data : { ok: false, reason: "invalid_session" };
  },
  async clearSession() {
    await ipcRenderer.invoke(INVOKE.clearSession);
  },
  async deviceName() {
    const raw: unknown = await ipcRenderer.invoke(INVOKE.deviceName);
    return typeof raw === "string" ? raw : "PC";
  },
  onSessionChanged: (listener) => subscribe(PUSH.session, StoredSession.nullable(), listener),
  brain: {
    async status() {
      const raw: unknown = await ipcRenderer.invoke(INVOKE.brainStatus);
      const parsed = ConnectionStatus.safeParse(raw);
      return parsed.success ? parsed.data : "offline";
    },
    send: (message) => call(z.boolean(), INVOKE.brainSend, message),
    onEvent: (listener) => subscribe(PUSH.brainEvent, ServerEvent, listener),
    onStatus: (listener) => subscribe(PUSH.brainStatus, ConnectionStatus, listener),
  },
  presence: {
    current: () => call(MascotState, INVOKE.presenceGet),
    onChange: (listener) => subscribe(PUSH.presence, MascotState, listener),
    typing: () => {
      void ipcRenderer.invoke(INVOKE.presenceTyping).catch(() => undefined);
    },
  },
  app: {
    version: () => call(z.string(), INVOKE.appVersion),
    showMain: () => call(z.undefined(), INVOKE.showMain),
    openConversation: (conversationId) => call(z.undefined(), INVOKE.openConversation, conversationId),
    onOpenConversation: (listener) => subscribe(PUSH.openConversation, z.uuid(), listener),
  },
};

contextBridge.exposeInMainWorld("alicia", bridge);
