import { fileURLToPath } from "node:url";
import { BrowserWindow, shell, type WebContents, type WebPreferences } from "electron";
import type { Surface } from "../shared/surface.ts";

const PRELOAD = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));

export interface WindowManagerOptions {
  /** The bundled page (production). */
  rendererIndex: string;
  /** Dev server URL (unpackaged `electron-vite dev` only). */
  devUrl: string | undefined;
  /** Window and taskbar icon, when present. */
  icon: string | undefined;
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

function secureWebPreferences(): WebPreferences {
  return { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false };
}

/** The app's windows. They all load the same page, each as its own surface (`?surface=`). */
export class WindowManager {
  readonly #options: WindowManagerOptions;
  #main: BrowserWindow | null = null;

  constructor(options: WindowManagerOptions) {
    this.#options = options;
  }

  createMain(options: { show: boolean }): void {
    const window = new BrowserWindow({
      ...(this.#options.icon !== undefined ? { icon: this.#options.icon } : {}),
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: false,
      backgroundColor: "#16213e",
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#121a32", symbolColor: "#f3ebdd", height: 40 },
      webPreferences: secureWebPreferences(),
    });
    if (options.show) {
      window.once("ready-to-show", () => {
        window.show();
      });
    }
    this.#harden(window);
    this.#load(window, "main");
    this.#main = window;
  }

  /** Which of our windows sent an IPC message (undefined: not one of ours). */
  surfaceOf(contents: WebContents): Surface | undefined {
    const main = this.#main;
    if (main !== null && !main.isDestroyed() && main.webContents === contents) return "main";
    return undefined;
  }

  /** Sends to every open window. */
  broadcast(channel: string, payload?: unknown): void {
    for (const window of this.#windows()) window.webContents.send(channel, payload);
  }

  #windows(): BrowserWindow[] {
    return [this.#main].filter((window): window is BrowserWindow => window !== null && !window.isDestroyed());
  }

  /** The app never navigates away nor opens windows; external links go to the browser. */
  #harden(window: BrowserWindow): void {
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  }

  #load(window: BrowserWindow, surface: Surface): void {
    const devUrl = this.#options.devUrl;
    if (devUrl !== undefined) {
      const url = new URL(devUrl);
      url.searchParams.set("surface", surface);
      void window.loadURL(url.href);
    } else {
      void window.loadFile(this.#options.rendererIndex, { query: { surface } });
    }
  }
}
