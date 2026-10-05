import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, type IpcMainInvokeEvent, safeStorage, session } from "electron";
import { z } from "zod";
import { PUSH } from "../shared/bridge.ts";
import { openWebSocket } from "../shared/chat-connection.ts";
import { DiscoveredBrain } from "../shared/discovery.ts";
import { type SaveSessionResult, StoredSession } from "../shared/session.ts";
import type { SettingsPatch } from "../shared/settings.ts";
import type { Surface } from "../shared/surface.ts";
import { BrainHub } from "./brain-hub.ts";
import { type BrainBrowser, BrainDiscovery, bonjourBrowser, staticBrowser } from "./discovery.ts";
import { electronOs } from "./electron-os.ts";
import { eventRecipients, mayReadSession } from "./event-routing.ts";
import { registerIpc } from "./ipc.ts";
import { isHiddenLaunch, runOnce } from "./lifecycle.ts";
import type { OsIntegration, TrayHandle } from "./os-integration.ts";
import { Presence } from "./presence.ts";
import { RecordingOs, TEST_HOOKS_KEY } from "./recording-os.ts";
import { EncryptionUnavailableError, SessionStore } from "./session-store.ts";
import { SettingsController } from "./settings-controller.ts";
import { SettingsStore } from "./settings-store.ts";
import { type TrayAction, type TrayItem, trayMenuItems } from "./tray-menu.ts";
import { isTrustedSenderUrl } from "./trusted-sender.ts";
import { confirmationNotification, notificationFor } from "./turn-notifications.ts";
import { electronUpdateEngine, UpdateController } from "./updater.ts";
import { hardenWebContents, WindowManager } from "./windows.ts";

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
/** Real mDNS; in tests, the brains listed in ALICIA_TEST_BRAINS (JSON, validated) and nothing from the network. */
function brainBrowser(): BrainBrowser {
  if (!osIntegrationOff) return bonjourBrowser();
  const raw = process.env["ALICIA_TEST_BRAINS"];
  return staticBrowser(raw === undefined ? [] : z.array(DiscoveredBrain).parse(JSON.parse(raw)));
}

/** Started by Windows at login (login item argument): stay in the notification area. */
const startHidden = isHiddenLaunch(process.argv);

/** Said in a Windows notification when a change from the tray menu could not be saved. */
const SETTING_NOT_SAVED = "Impossible d'enregistrer ce réglage pour l'instant.";

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

  // The test profile keeps the recorded login item between runs, as Windows would.
  const recording = osIntegrationOff
    ? new RecordingOs({ loginItemFile: join(app.getPath("userData"), "test-login-item.json") })
    : null;
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
    onHoloDismissed: () => {
      updateFromOutside({ showHolo: false });
    },
    onSessionEnd: () => {
      quitCleanup();
    },
    cursor: () => os.cursorScreenPoint(),
    onMainVisibility: (visible) => {
      discovery.setVisible(visible);
    },
    isFocused: (window) => os.isFocused(window),
    // A page reloaded or crashed while Réglages captured a new shortcut can never resume it: done here.
    onMainReset: () => {
      settings.resumeShortcut();
    },
  });
  const presence = new Presence({
    schedule,
    onChange: (mood) => {
      windows.broadcast(PUSH.presence, mood);
    },
  });
  /** Alicia waits for a yes or no the person cannot see: a notification leads to the card. */
  const notifyConfirmation = (event: { conversationId: string; summary: string }, owner: Surface): void => {
    const notification = confirmationNotification(event, owner, windows.visibility());
    if (notification === null) return;
    os.notify({
      title: notification.title,
      body: notification.body,
      onClick: () => {
        if (notification.surface === "holo") {
          windows.openHoloChat();
          return;
        }
        windows.showMain();
        // A Spotlight question: its card waits in that conversation.
        if (owner === "spotlight") windows.openConversation(notification.conversationId);
      },
    });
  };
  // The only WebSocket to the brain: Node's has no Origin header, which the brain accepts as a native client.
  const hub = new BrainHub({
    openSocket: openWebSocket,
    schedule,
    onEvent: (event, owner) => {
      // A turn's events only reach the window that asked (another one may be starting its own conversation).
      for (const surface of eventRecipients(event, owner, windows.surfaces())) windows.sendTo(surface, PUSH.brainEvent, event);
      presence.event(event);
      if (event.type === "confirm_request" && owner !== undefined) notifyConfirmation(event, owner);
    },
    onStatus: (status) => {
      windows.broadcast(PUSH.brainStatus, status);
      // Signed out on purpose: the closed connection is not a problem to show.
      if (current === null) presence.signedOut();
      else presence.status(status);
      // A failed update check is retried as soon as the brain answers again.
      if (status === "ready") updates.brainReachable();
    },
    onSent: (_origin, pendingTurns) => {
      presence.sent(pendingTurns);
    },
    onTurnFinished: (turn, pendingTurns) => {
      presence.finished(turn, pendingTurns);
      // A failed turn may have created its conversation: only its own window heard of it.
      if (turn.outcome === "failed" && turn.conversationId !== undefined) windows.broadcast(PUSH.conversationsChanged);
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
  // Brains on the local network, looked for only while the pairing screen is shown.
  const discovery = new BrainDiscovery(brainBrowser(), (brains) => {
    windows.sendTo("main", PUSH.discovery, brains);
  });
  // Until the main window shows (never, when started at login), nothing is looked for.
  discovery.setVisible(false);
  // Updates from the paired brain, in the installed app only. Installing quits through app.quit, hence the
  // app's one quit path (before-quit, then will-quit and its cleanup).
  let updateReady = false;
  const updates = new UpdateController(
    app.isPackaged ? electronUpdateEngine() : null,
    schedule,
    (status) => {
      windows.broadcast(PUSH.updates, status);
      // The tray only offers the install: no need to rebuild its menu on every download step.
      if ((status.state === "ready") !== updateReady) {
        updateReady = status.state === "ready";
        refreshTray();
      }
    },
  );
  const settings = new SettingsController(new SettingsStore(join(app.getPath("userData"), "settings.json")), {
    registerShortcut: (accelerator) =>
      os.registerShortcut(accelerator, () => {
        windows.toggleSpotlight();
      }),
    unregisterShortcut: (accelerator) => {
      os.unregisterShortcut(accelerator);
    },
    setLoginItem: (openAtLogin) => {
      os.setLoginItem(openAtLogin);
    },
    isLoginItemEnabled: () => os.isLoginItemEnabled(),
    onChange: (snapshot) => {
      windows.broadcast(PUSH.settings, snapshot);
      applyHolo();
      refreshTray();
    },
  });

  /** Lets go of the brain, the network and the OS (shortcut, tray icon); shared by every way of quitting. */
  const quitCleanup = runOnce(() => {
    discovery.stop();
    updates.stop();
    hub.disconnect();
    os.dispose();
  });

  function trayItems(): TrayItem[] {
    const { showHolo, launchAtStartup } = settings.snapshot.settings;
    return trayMenuItems({ paired: current !== null, showHolo, launchAtStartup, updateReady: updates.status.state === "ready" });
  }

  function refreshTray(): void {
    tray?.update(trayItems());
  }

  /** The Holo floats on the desktop when the device is paired and the person wants it. */
  function applyHolo(): void {
    windows.setHoloVisible(current !== null && settings.snapshot.settings.showHolo);
  }

  /**
   * A change asked from outside the Réglages screen (tray menu, Alt+F4 on the Holo), where there is no room for
   * an error: a refusal is a notification.
   */
  function updateFromOutside(patch: SettingsPatch): void {
    if (settings.update(patch).ok) return;
    os.notify({
      title: "Alicia",
      body: SETTING_NOT_SAVED,
      onClick: () => {
        windows.showMain();
      },
    });
  }

  function onTrayAction(action: TrayAction): void {
    switch (action) {
      case "open":
        windows.showMain();
        return;
      case "toggle-holo":
        updateFromOutside({ showHolo: !settings.snapshot.settings.showHolo });
        return;
      case "toggle-startup":
        updateFromOutside({ launchAtStartup: !settings.snapshot.settings.launchAtStartup });
        return;
      case "install-update":
        updates.install();
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
    for (const surface of windows.surfaces().filter(mayReadSession)) windows.sendTo(surface, PUSH.session, next);
    windows.broadcast(PUSH.paired, next !== null);
    updates.setServer(next?.serverUrl ?? null);
    applyHolo();
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
      paired: () => current !== null,
      save: saveSession,
      clear: () => {
        sessions.clear();
        setSession(null);
      },
    },
    windows,
    hub,
    presence,
    settings,
    discovery,
    updates,
  });

  windows.createMain({ show: !startHidden });
  windows.createSpotlight();
  windows.setHoloAnchor(settings.snapshot.settings.holoAnchor);
  applyHolo();
  tray = os.createTray(trayItems(), onTrayAction, () => {
    windows.showMain();
  });
  settings.start();
  updates.setServer(current?.serverUrl ?? null);
  if (current !== null) hub.connect(current);

  // A second launch brings Alicia forward, unless it is Windows starting her at login.
  app.on("second-instance", (_event, argv) => {
    if (!isHiddenLaunch(argv)) windows.showMain();
  });
  app.on("before-quit", () => {
    windows.prepareQuit();
  });
  app.on("will-quit", () => {
    quitCleanup();
  });
}

// Defense in depth: whatever creates a web page (our windows, a future dialog…), it is locked down.
app.on("web-contents-created", (_event, contents) => {
  hardenWebContents(contents);
});

// One Alicia per Windows session (per profile): a second launch only brings the first one forward.
if (app.requestSingleInstanceLock()) {
  void app.whenReady().then(start);
} else {
  app.quit();
}
app.on("window-all-closed", () => {
  app.quit();
});
