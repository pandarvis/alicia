import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, safeStorage, session, shell } from "electron";
import { IPC, type SaveSessionResult, StoredSession } from "../shared/session.ts";
import { EncryptionUnavailableError, SessionStore } from "./session-store.ts";
import { isTrustedSenderUrl } from "./trusted-sender.ts";

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

/** Only our own renderer page may talk to the session store. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (!isTrustedSenderUrl(url, { rendererFileUrl: pathToFileURL(RENDERER_INDEX).href, devUrl: devServerUrl() })) {
    throw new Error("Untrusted IPC sender");
  }
}

function saveSession(store: SessionStore, raw: unknown): SaveSessionResult {
  const parsed = StoredSession.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_session" };
  try {
    store.save(parsed.data);
    return { ok: true };
  } catch (error) {
    if (error instanceof EncryptionUnavailableError) return { ok: false, reason: "encryption_unavailable" };
    throw error;
  }
}

function registerIpc(store: SessionStore): void {
  ipcMain.handle(IPC.getSession, (event) => {
    assertTrusted(event);
    return store.load();
  });
  ipcMain.handle(IPC.saveSession, (event, raw: unknown) => {
    assertTrusted(event);
    return saveSession(store, raw);
  });
  ipcMain.handle(IPC.clearSession, (event) => {
    assertTrusted(event);
    store.clear();
  });
  ipcMain.handle(IPC.deviceName, (event) => {
    assertTrusted(event);
    return hostname();
  });
}

/** Only web links leave the app; anything else (file:, custom schemes) is refused. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    // Window and taskbar icon (the installer's .ico comes with packaging, plan 4b).
    ...(existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#16213e",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#121a32", symbolColor: "#f3ebdd", height: 40 },
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  // The app never navigates away nor opens windows; external links go to the browser.
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = devServerUrl();
  if (devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(RENDERER_INDEX);
}

void app.whenReady().then(() => {
  // Deny every browser permission (camera, mic, notifications…) until a feature explicitly needs one.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  registerIpc(
    new SessionStore(join(app.getPath("userData"), "session.bin"), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data),
    }),
  );
  createWindow();
});
app.on("window-all-closed", () => {
  app.quit();
});
