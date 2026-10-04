import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, type IpcMainInvokeEvent, safeStorage, session } from "electron";
import { PUSH } from "../shared/bridge.ts";
import { openWebSocket } from "../shared/chat-connection.ts";
import { type SaveSessionResult, StoredSession } from "../shared/session.ts";
import { BrainHub } from "./brain-hub.ts";
import { registerIpc } from "./ipc.ts";
import { Presence } from "./presence.ts";
import { EncryptionUnavailableError, SessionStore } from "./session-store.ts";
import { isTrustedSenderUrl } from "./trusted-sender.ts";
import { WindowManager } from "./windows.ts";

const RENDERER_INDEX = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
/** Mascot head icon (design/mascotte/icone/v1), exported to build/ for electron-builder too. */
const APP_ICON = join(app.getAppPath(), "build", "icon.png");
// Own taskbar identity on Windows: otherwise the window is grouped under Electron's icon.
app.setAppUserModelId("fr.pandarvis.alicia");

// Lets the end-to-end test isolate its profile; ignored in a packaged app.
const userDataOverride = process.env["ALICIA_USER_DATA"];
if (!app.isPackaged && userDataOverride !== undefined) app.setPath("userData", userDataOverride);

/** The dev server URL, only ever honoured when running unpackaged. */
function devServerUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
}

/** Only our own page (whatever its `?surface=`) may talk to the main process. */
function isTrusted(event: IpcMainInvokeEvent): boolean {
  return isTrustedSenderUrl(event.senderFrame?.url, {
    rendererFileUrl: pathToFileURL(RENDERER_INDEX).href,
    devUrl: devServerUrl(),
  });
}

function schedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => {
    clearTimeout(timer);
  };
}

function start(): void {
  // Deny every browser permission (camera, mic, notifications…) until a feature explicitly needs one.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const sessions = new SessionStore(join(app.getPath("userData"), "session.bin"), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  const windows = new WindowManager({
    rendererIndex: RENDERER_INDEX,
    devUrl: devServerUrl(),
    icon: existsSync(APP_ICON) ? APP_ICON : undefined,
  });
  const presence = new Presence({
    schedule,
    onChange: (mood) => {
      windows.broadcast(PUSH.presence, mood);
    },
  });
  // The only WebSocket to the brain: Node's has no Origin header, which the brain accepts as a native client.
  const hub = new BrainHub({
    openSocket: openWebSocket,
    schedule,
    onEvent: (event) => {
      windows.broadcast(PUSH.brainEvent, event);
      presence.event(event);
    },
    onStatus: (status) => {
      windows.broadcast(PUSH.brainStatus, status);
      presence.status(status);
    },
    onSent: () => {
      presence.sent();
    },
    // Windows notifications arrive with the tray (task 8).
    onTurnFinished: () => undefined,
  });

  /** Paired or signed out: (re)connect, and tell every window. */
  function setSession(next: StoredSession | null): void {
    if (next === null) hub.disconnect();
    else hub.connect(next);
    windows.broadcast(PUSH.session, next);
  }

  function saveSession(raw: unknown): SaveSessionResult {
    const parsed = StoredSession.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid_session" };
    try {
      sessions.save(parsed.data);
    } catch (error) {
      if (error instanceof EncryptionUnavailableError) return { ok: false, reason: "encryption_unavailable" };
      throw error;
    }
    setSession(parsed.data);
    return { ok: true };
  }

  registerIpc({
    isTrusted,
    session: {
      get: () => sessions.load(),
      save: saveSession,
      clear: () => {
        sessions.clear();
        setSession(null);
      },
    },
    windows,
    hub,
    presence,
  });
  windows.createMain({ show: true });
  const saved = sessions.load();
  if (saved !== null) hub.connect(saved);
}

void app.whenReady().then(start);
app.on("window-all-closed", () => {
  app.quit();
});
