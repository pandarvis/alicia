import type { ConfirmMessage, SendMessage, ServerEvent } from "@alicia/protocol";
import type { ConnectionStatus } from "./chat-connection.ts";
import type { DiscoveredBrain } from "./discovery.ts";
import type { GoogleAuthorizeRequest, GoogleAuthorizeResult } from "./google.ts";
import type { HoloView } from "./holo.ts";
import type { MascotState } from "./mascot.ts";
import type { SaveSessionResult, StoredSession } from "./session.ts";
import type { SettingsPatch, SettingsSnapshot, SettingsUpdateResult } from "./settings.ts";
import type { UpdateStatus } from "./updates.ts";

export type Unsubscribe = () => void;

/** The brain connection, owned by the main process (BrainHub) and mirrored in every window. */
export interface BrainBridge {
  status(): Promise<ConnectionStatus>;
  /** True once the main process handed the message to the brain. */
  send(message: SendMessage): Promise<boolean>;
  /**
   * The answer to a confirmation card of this window's turn; true once handed to the brain. Refused for a card
   * another window's turn asked, one already answered or settled, or when the brain cannot be reached.
   */
  confirm(message: ConfirmMessage): Promise<boolean>;
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe;
  /** A turn failed after its conversation was created: the conversation lists may have changed. */
  onConversationsChanged(listener: () => void): Unsubscribe;
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
  /** From the Holo's « Reconnecter le compte » card: the main window shows Comptes and reconnects this account. */
  reconnectAccount(accountId: string): Promise<void>;
  /** The main window is asked to reconnect a Google account (Comptes, then Google's consent). */
  onReconnectAccount(listener: (accountId: string) => void): Unsubscribe;
}

/** For the floating windows (Holo, Spotlight): entrance and exit animations around show/hide. */
export interface SurfaceBridge {
  /** The window was just shown: play the entrance. */
  onShown(listener: () => void): Unsubscribe;
  /**
   * The main process wants this window hidden: play the exit, then call hideSelf. hideSelf only hides the showing
   * the page last heard of: shown again meanwhile, the window stays.
   */
  onHideRequest(listener: () => void): Unsubscribe;
  hideSelf(): Promise<void>;
}

export interface HoloBridge {
  dragStart(): Promise<void>;
  /** The pointer moved: the main process moves the Holo with the pointer it sees on the desktop. */
  dragMove(): Promise<void>;
  /** Ends the drag; the new place is remembered. */
  dragEnd(): Promise<void>;
  /** Grows or shrinks the window around the mascot; answers how to lay the page out. */
  setExpanded(expanded: boolean): Promise<HoloView>;
  /** The layout changed without the page asking (dragged across the screen, a screen changed). */
  onView(listener: (view: HoloView) => void): Unsubscribe;
  /** A notification asks to open the mini-chat (Alicia waits there for a yes or no). */
  onOpenChat(listener: () => void): Unsubscribe;
}

/** The app's settings, owned by the main process (Réglages screen). */
export interface SettingsBridge {
  get(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsUpdateResult>;
  /** Changed from another place (tray menu, Holo closed with Alt+F4…). */
  onChange(listener: (snapshot: SettingsSnapshot) => void): Unsubscribe;
  /** Sets the global shortcut aside while a new one is typed (true), or brings it back (false). */
  suspendShortcut(suspended: boolean): Promise<void>;
}

/** Brains found on the local network (mDNS), for the pairing screen of the main window only. */
export interface DiscoveryBridge {
  /** Starts looking for brains on the local network; answers those already found. */
  start(): Promise<DiscoveredBrain[]>;
  stop(): Promise<void>;
  onChange(listener: (brains: DiscoveredBrain[]) => void): Unsubscribe;
}

/** Automatic updates of the installed app, from the paired brain. */
export interface UpdatesBridge {
  status(): Promise<UpdateStatus>;
  /** Restarts into the downloaded version. */
  install(): Promise<void>;
  onChange(listener: (status: UpdateStatus) => void): Unsubscribe;
}

/** Google's consent for the Comptes screen, main window only: the main process runs it in the system browser. */
export interface GoogleBridge {
  /**
   * Opens Google's consent page in the person's browser and waits for its answer on a local loopback; resolves with
   * the code for the brain to exchange, or why there is none. A new consent cancels the one in progress.
   */
  authorize(request: GoogleAuthorizeRequest): Promise<GoogleAuthorizeResult>;
  /** Cancels the consent in progress, if any. */
  cancel(): Promise<void>;
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
  updates: UpdatesBridge;
  google: GoogleBridge;
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
  brainConfirm: "brain:confirm",
  presenceGet: "presence:get",
  presenceTyping: "presence:typing",
  appVersion: "app:version",
  showMain: "app:show-main",
  openConversation: "app:open-conversation",
  reconnectAccount: "app:reconnect-account",
  hideSelf: "window:hide-self",
  holoDragStart: "holo:drag-start",
  holoDragMove: "holo:drag-move",
  holoDragEnd: "holo:drag-end",
  holoSetExpanded: "holo:set-expanded",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsSuspendShortcut: "settings:suspend-shortcut",
  discoveryStart: "discovery:start",
  discoveryStop: "discovery:stop",
  updatesStatus: "updates:status",
  updatesInstall: "updates:install",
  googleAuthorize: "google:authorize",
  googleCancel: "google:cancel",
} as const;

/** Main process → pages (webContents.send); the preload validates every payload. */
export const PUSH = {
  session: "push:session",
  paired: "push:paired",
  brainEvent: "push:brain-event",
  brainStatus: "push:brain-status",
  presence: "push:presence",
  openConversation: "push:open-conversation",
  reconnectAccount: "push:reconnect-account",
  shown: "push:shown",
  hideRequest: "push:hide-request",
  holoView: "push:holo-view",
  holoOpenChat: "push:holo-open-chat",
  conversationsChanged: "push:conversations-changed",
  settings: "push:settings",
  discovery: "push:discovery",
  updates: "push:updates",
} as const;
