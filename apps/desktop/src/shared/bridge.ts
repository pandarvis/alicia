import type { SendMessage, ServerEvent } from "@alicia/protocol";
import type { ConnectionStatus } from "./chat-connection.ts";
import type { MascotState } from "./mascot.ts";
import type { SaveSessionResult, StoredSession } from "./session.ts";

export type Unsubscribe = () => void;

/** The brain connection, owned by the main process (BrainHub) and mirrored in every window. */
export interface BrainBridge {
  status(): Promise<ConnectionStatus>;
  /** True once the main process handed the message to the brain. */
  send(message: SendMessage): Promise<boolean>;
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe;
}

/** Alicia's mood for the whole PC. */
export interface PresenceBridge {
  current(): Promise<MascotState>;
  onChange(listener: (mood: MascotState) => void): Unsubscribe;
  /** Someone types to Alicia (fire and forget). */
  typing(): void;
}

/** The app itself: its version, and the main window. */
export interface AppBridge {
  version(): Promise<string>;
  showMain(): Promise<void>;
  /** Shows the main window on this conversation. */
  openConversation(conversationId: string): Promise<void>;
  /** A notification (or another window) asks the main window to show a conversation. */
  onOpenConversation(listener: (conversationId: string) => void): Unsubscribe;
}

/** API exposed to every page as `window.alicia` by the preload script. */
export interface AliciaBridge {
  getSession(): Promise<StoredSession | null>;
  saveSession(session: StoredSession): Promise<SaveSessionResult>;
  clearSession(): Promise<void>;
  deviceName(): Promise<string>;
  /** Paired or signed out, whichever window did it. */
  onSessionChanged(listener: (session: StoredSession | null) => void): Unsubscribe;
  brain: BrainBridge;
  presence: PresenceBridge;
  app: AppBridge;
}

/** Page → main process (ipcRenderer.invoke); every handler checks the sender and validates the payload. */
export const INVOKE = {
  getSession: "session:get",
  saveSession: "session:save",
  clearSession: "session:clear",
  deviceName: "device:name",
  brainStatus: "brain:status",
  brainSend: "brain:send",
  presenceGet: "presence:get",
  presenceTyping: "presence:typing",
  appVersion: "app:version",
  showMain: "app:show-main",
  openConversation: "app:open-conversation",
} as const;

/** Main process → pages (webContents.send); the preload validates every payload. */
export const PUSH = {
  session: "push:session",
  brainEvent: "push:brain-event",
  brainStatus: "push:brain-status",
  presence: "push:presence",
  openConversation: "push:open-conversation",
} as const;
