import type { SendMessage, ServerEvent } from "@alicia/protocol";
import type { ConnectionStatus } from "./chat-connection.ts";
import type { DiscoveredBrain } from "./discovery.ts";
import type { DragDelta, HoloView } from "./holo.ts";
import type { MascotState } from "./mascot.ts";
import type { SaveSessionResult, StoredSession } from "./session.ts";
import type { SettingsPatch, SettingsSnapshot, SettingsUpdateResult } from "./settings.ts";

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

/** For the floating windows (Holo, Spotlight): entrance and exit animations around show/hide. */
export interface SurfaceBridge {
  /** The window was just shown: play the entrance. */
  onShown(listener: () => void): Unsubscribe;
  /** The main process wants this window hidden: play the exit, then call hideSelf. */
  onHideRequest(listener: () => void): Unsubscribe;
  hideSelf(): Promise<void>;
}

export interface HoloBridge {
  dragStart(): Promise<void>;
  /** Offset from where the drag started, in screen pixels. */
  dragTo(delta: DragDelta): Promise<void>;
  /** Ends the drag; the new place is remembered. */
  dragEnd(): Promise<void>;
  /** Grows or shrinks the window around the mascot; answers how to lay the page out. */
  setExpanded(expanded: boolean): Promise<HoloView>;
}

/** The app's settings, owned by the main process (Réglages screen). */
export interface SettingsBridge {
  get(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsUpdateResult>;
  /** Changed from another place (tray menu, Holo closed with Alt+F4…). */
  onChange(listener: (snapshot: SettingsSnapshot) => void): Unsubscribe;
}

/** Brains found on the local network (mDNS), for the pairing screen of the main window only. */
export interface DiscoveryBridge {
  /** Starts looking for brains on the local network; answers those already found. */
  start(): Promise<DiscoveredBrain[]>;
  stop(): Promise<void>;
  onChange(listener: (brains: DiscoveredBrain[]) => void): Unsubscribe;
}

/** API exposed to every page as `window.alicia` by the preload script. */
export interface AliciaBridge {
  getSession(): Promise<StoredSession | null>;
  saveSession(session: StoredSession): Promise<SaveSessionResult>;
  clearSession(): Promise<void>;
  deviceName(): Promise<string>;
  /** Paired or signed out, whichever window did it. */
  onSessionChanged(listener: (session: StoredSession | null) => void): Unsubscribe;
  /** Whether the device is paired, for windows that may not read the session (Spotlight). */
  paired(): Promise<boolean>;
  onPairedChanged(listener: (paired: boolean) => void): Unsubscribe;
  brain: BrainBridge;
  presence: PresenceBridge;
  app: AppBridge;
  surface: SurfaceBridge;
  holo: HoloBridge;
  settings: SettingsBridge;
  discovery: DiscoveryBridge;
}

/** Page → main process (ipcRenderer.invoke); every handler checks the sender and validates the payload. */
export const INVOKE = {
  getSession: "session:get",
  paired: "session:paired",
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
  hideSelf: "window:hide-self",
  holoDragStart: "holo:drag-start",
  holoDragTo: "holo:drag-to",
  holoDragEnd: "holo:drag-end",
  holoSetExpanded: "holo:set-expanded",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  discoveryStart: "discovery:start",
  discoveryStop: "discovery:stop",
} as const;

/** Main process → pages (webContents.send); the preload validates every payload. */
export const PUSH = {
  session: "push:session",
  paired: "push:paired",
  brainEvent: "push:brain-event",
  brainStatus: "push:brain-status",
  presence: "push:presence",
  openConversation: "push:open-conversation",
  shown: "push:shown",
  hideRequest: "push:hide-request",
  settings: "push:settings",
  discovery: "push:discovery",
} as const;
