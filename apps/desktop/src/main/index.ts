import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

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
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
}

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  app.quit();
});
