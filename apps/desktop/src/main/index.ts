import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, type IpcMainInvokeEvent, safeStorage, session } from "electron";
import { PUSH } from "../shared/bridge.ts";
import { openWebSocket } from "../shared/chat-connection.ts";
import { type SaveSessionResult, StoredSession } from "../shared/session.ts";
import { BrainHub } from "./brain-hub.ts";
import { electronOs } from "./electron-os.ts";
import { registerIpc } from "./ipc.ts";
import type { OsIntegration, TrayHandle } from "./os-integration.ts";
import { Presence } from "./presence.ts";
import { RecordingOs, TEST_HOOKS_KEY } from "./recording-os.ts";
import { EncryptionUnavailableError, SessionStore } from "./session-store.ts";
import { SettingsController } from "./settings-controller.ts";
import { SettingsStore } from "./settings-store.ts";
import { type TrayAction, type TrayItem, trayMenuItems } from "./tray-menu.ts";
import { isTrustedSenderUrl } from "./trusted-sender.ts";
import { notificationFor } from "./turn-notifications.ts";
import { WindowManager } from "./windows.ts";

const RENDERER_INDEX = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
/** Mascot head icon (design/mascotte/icone/v1), packaged with the app (electron-builder `files`). */
const ICON_PNG = join(app.getAppPath(), "build", "icon.png");
/** Multi-size icon, sharp in the notification area. */
const ICON_ICO = join(app.getAppPath(), "build", "icon.ico");
// Own taskbar identity on Windows (and the installer's shortcut uses the same id, for notifications).
app.setAppUserModelId("fr.pandarvis.alicia");

// Lets the end-to-end test isolate its profile; ignored in a packaged app. Must run before the single-instance lock.
const userDataOverride = process.env["ALICIA_USER_DATA"];
if (!app.isPackaged && userDataOverride !== undefined) app.setPath("userData", userDataOverride);

/**
 * Tests (unpackaged only) turn off everything that reaches outside the app: global shortcut, login item,
 * notification-area icon, Windows notifications, mDNS. A recorder stands in, exposed as globalThis.__aliciaTest.
 */
const osIntegrationOff = !app.isPackaged && process.env["ALICIA_OS_INTEGRATION"] === "off";
/** Started by Windows at login (login item argument): stay in the notification area. */
const startHidden = process.argv.includes("--hidden");

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
  // Deny every browser permission (camera, mic, web notifications…) until a feature explicitly needs one.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const recording = osIntegrationOff ? new RecordingOs() : null;
  if (recording !== null) Reflect.set(globalThis, TEST_HOOKS_KEY, recording.hooks());
  const os: OsIntegration = recording ?? electronOs({ trayIcon: ICON_ICO, notificationIcon: ICON_PNG });

  const sessions = new SessionStore(join(app.getPath("userData"), "session.bin"), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  let current: StoredSession | null = sessions.load();
  let tray: TrayHandle | null = null;

  const windows = new WindowManager({
    rendererIndex: RENDERER_INDEX,
    devUrl: devServerUrl(),
    icon: existsSync(ICON_PNG) ? ICON_PNG : undefined,
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
    onTurnFinished: (turn) => {
      const notification = notificationFor(turn, windows.visibility());
      if (notification === null) return;
      os.notify({
        title: notification.title,
        body: notification.body,
        onClick: () => {
          windows.showMain();
          if (notification.openConversation && notification.conversationId !== undefined) {
            windows.openConversation(notification.conversationId);
          }
        },
      });
    },
  });
  const settings = new SettingsController(new SettingsStore(join(app.getPath("userData"), "settings.json")), {
    // Until the Spotlight bar exists (task 10), the shortcut brings Alicia's window forward.
    registerShortcut: (accelerator) =>
      os.registerShortcut(accelerator, () => {
        windows.showMain();
      }),
    unregisterShortcut: (accelerator) => {
      os.unregisterShortcut(accelerator);
    },
    setLoginItem: (openAtLogin) => {
      os.setLoginItem(openAtLogin);
    },
    onChange: () => {
      refreshTray();
    },
  });

  function trayItems(): TrayItem[] {
    const { showHolo, launchAtStartup } = settings.snapshot.settings;
    return trayMenuItems({ paired: current !== null, showHolo, launchAtStartup, updateReady: false });
  }

  function refreshTray(): void {
    tray?.update(trayItems());
  }

  function onTrayAction(action: TrayAction): void {
    switch (action) {
      case "open":
        windows.showMain();
        return;
      case "toggle-holo":
        // A refused change (settings file locked) leaves the menu as it was.
        settings.update({ showHolo: !settings.snapshot.settings.showHolo });
        return;
      case "toggle-startup":
        settings.update({ launchAtStartup: !settings.snapshot.settings.launchAtStartup });
        return;
      case "install-update":
        // Offered once updates exist (task 15).
        return;
      case "quit":
        app.quit();
        return;
    }
  }

  /** Paired or signed out: (re)connect, and tell every window. */
  function setSession(next: StoredSession | null): void {
    current = next;
    if (next === null) hub.disconnect();
    else hub.connect(next);
    windows.broadcast(PUSH.session, next);
    refreshTray();
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

  windows.createMain({ show: !startHidden });
  tray = os.createTray(trayItems(), onTrayAction, () => {
    windows.showMain();
  });
  settings.start();
  if (current !== null) hub.connect(current);

  app.on("second-instance", () => {
    windows.showMain();
  });
  app.on("before-quit", () => {
    windows.prepareQuit();
  });
  app.on("will-quit", () => {
    hub.disconnect();
    os.dispose();
  });
}

// One Alicia per Windows session (per profile): a second launch only brings the first one forward.
if (app.requestSingleInstanceLock()) {
  void app.whenReady().then(start);
} else {
  app.quit();
}
app.on("window-all-closed", () => {
  app.quit();
});
