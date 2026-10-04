import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { IPC, StoredSession } from "../shared/session.ts";
import { SessionStore } from "./session-store.ts";

// Lets the end-to-end test isolate its profile.
const userDataOverride = process.env["ALICIA_USER_DATA"];
if (userDataOverride !== undefined) app.setPath("userData", userDataOverride);

function registerIpc(store: SessionStore): void {
  ipcMain.handle(IPC.getSession, () => store.load());
  ipcMain.handle(IPC.saveSession, (_event, raw: unknown) => {
    store.save(StoredSession.parse(raw));
  });
  ipcMain.handle(IPC.clearSession, () => {
    store.clear();
  });
  ipcMain.handle(IPC.deviceName, () => hostname());
}

function createWindow(): void {
  const window = new BrowserWindow({
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
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
}

void app.whenReady().then(() => {
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
