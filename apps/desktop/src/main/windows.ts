import { fileURLToPath } from "node:url";
import { BrowserWindow, screen, shell, type WebContents, type WebPreferences } from "electron";
import { PUSH } from "../shared/bridge.ts";
import type { HoloView, Point } from "../shared/holo.ts";
import type { Surface } from "../shared/surface.ts";
import {
  clampAnchor, HOLO_SIZE, holoAnchor, type HoloLayout, holoLayout, nearestWorkArea, type Rect, SPOTLIGHT_SIZE,
  spotlightBounds,
} from "./layout.ts";
import { onPageReset } from "./page-reset.ts";
import type { Visibility } from "./turn-notifications.ts";

const PRELOAD = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
/** A window asked to fade out hides anyway after this delay. */
const HIDE_FALLBACK_MS = 400;

export interface WindowManagerOptions {
  /** The bundled page (production). */
  rendererIndex: string;
  /** Dev server URL (unpackaged `electron-vite dev` only). */
  devUrl: string | undefined;
  /** Window and taskbar icon, when present. */
  icon: string | undefined;
  /** Alt+F4 on the Holo: the person does not want it any more (same as unticking it). */
  onHoloDismissed(): void;
  /** Windows is logging off or shutting down: the process ends without before-quit nor will-quit. */
  onSessionEnd(): void;
  /** Where the mouse pointer is on the desktop (screen DIP). */
  cursor(): Point;
  /** The main window was shown (true) or hidden or minimized (false). */
  onMainVisibility(visible: boolean): void;
  /** Whether a window has the keyboard focus (in front of the person). */
  isFocused(window: BrowserWindow): boolean;
  /** The main page lost its state (reloaded, crashed, closed): what it had set up must be undone. */
  onMainReset(): void;
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

/** A window whose page can still receive messages (a closing window's contents may already be gone). */
function isAlive(window: BrowserWindow | null): window is BrowserWindow {
  return window !== null && !window.isDestroyed() && !window.webContents.isDestroyed();
}

/**
 * No page of the app ever navigates away, opens a window (web links go to the browser) or embeds a webview.
 * Applied to every web contents the app creates (`web-contents-created`), and again to each of our windows.
 */
export function hardenWebContents(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function secureWebPreferences(): WebPreferences {
  return { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false };
}

/** The work areas of the connected screens, and the primary one (the Holo may live on any of them). */
function workAreas(): { areas: Rect[]; primary: Rect } {
  return { areas: screen.getAllDisplays().map((display) => display.workArea), primary: screen.getPrimaryDisplay().workArea };
}

/** The app's windows. They all load the same page, each as its own surface (`?surface=`). */
export class WindowManager {
  readonly #options: WindowManagerOptions;
  #main: BrowserWindow | null = null;
  #holo: BrowserWindow | null = null;
  #spotlight: BrowserWindow | null = null;
  #quitting = false;
  /** Where the collapsed Holo sits (null: the default corner). */
  #anchor: Point | null = null;
  #expanded = false;
  #dragOrigin: Point | null = null;
  /** Where the pointer was when the drag started. */
  #dragCursor: Point | null = null;
  /** The last view the Holo page was given (JSON), to push it again only when it changes. */
  #holoView: string | null = null;
  /** Each floating window's current showing (counted up at every show); its page closes that one only. */
  readonly #showings = new Map<BrowserWindow, number>();
  /** Windows asked to fade out, with their fallback timer. */
  readonly #hiding = new Map<BrowserWindow, ReturnType<typeof setTimeout>>();

  constructor(options: WindowManagerOptions) {
    this.#options = options;
    // A screen plugged, unplugged or rescaled: the Holo is laid out again (and stays on a screen that exists).
    const relayout = (): void => {
      if (isAlive(this.#holo)) this.#layoutHolo();
    };
    screen.on("display-added", relayout);
    screen.on("display-removed", relayout);
    screen.on("display-metrics-changed", relayout);
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
    // Closing the window keeps Alicia running in the notification area.
    window.on("close", (event) => {
      if (this.#quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.on("show", () => {
      this.#options.onMainVisibility(true);
    });
    window.on("restore", () => {
      this.#options.onMainVisibility(true);
    });
    window.on("hide", () => {
      this.#options.onMainVisibility(false);
    });
    window.on("minimize", () => {
      this.#options.onMainVisibility(false);
    });
    // Logoff or shutdown: Windows ends the process without before-quit, so the windows must let go here.
    window.on("session-end", () => {
      this.#quitting = true;
      this.#options.onSessionEnd();
    });
    if (options.show) {
      window.once("ready-to-show", () => {
        window.show();
      });
    }
    onPageReset(window.webContents, () => {
      this.#options.onMainReset();
    });
    this.#load(window, "main");
    this.#main = window;
  }

  /** Quitting for real (tray, update, Windows shutting down): windows may now close. */
  prepareQuit(): void {
    this.#quitting = true;
  }

  /** Brings the main window forward (second launch, tray, notification click). */
  showMain(): void {
    const window = this.#main;
    if (!isAlive(window)) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /** Asks the main window to show a conversation (it is already shown by then). */
  openConversation(conversationId: string): void {
    this.sendTo("main", PUSH.openConversation, conversationId);
  }

  /** What the person can see right now (decides notifications). */
  visibility(): Visibility {
    const holo = this.#holo;
    const holoShown = isAlive(holo) && holo.isVisible() && !this.#hiding.has(holo);
    return { main: this.#mainVisible(), holoChat: holoShown && this.#expanded };
  }

  /** Which of our windows sent an IPC message (undefined: not one of ours). */
  surfaceOf(contents: WebContents): Surface | undefined {
    for (const [surface, window] of this.#all()) {
      if (window.webContents === contents) return surface;
    }
    return undefined;
  }

  /** The surfaces whose window is open (created and not destroyed). */
  surfaces(): Surface[] {
    return this.#all().map(([surface]) => surface);
  }

  /** Sends to one surface's window, if it is open. */
  sendTo(surface: Surface, channel: string, payload?: unknown): void {
    const found = this.#all().find(([candidate]) => candidate === surface);
    found?.[1].webContents.send(channel, payload);
  }

  /** Sends to every open window. */
  broadcast(channel: string, payload?: unknown): void {
    for (const [, window] of this.#all()) window.webContents.send(channel, payload);
  }

  /** Created hidden at startup, so the shortcut shows it at once. */
  createSpotlight(): void {
    this.#ensureSpotlight();
  }

  /** The global shortcut: shows the bar on the screen under the pointer, or closes it. */
  toggleSpotlight(): void {
    const window = this.#ensureSpotlight();
    if (window.isVisible() && !this.#hiding.has(window)) {
      this.#requestHide(window);
      return;
    }
    this.#cancelHide(window);
    const { areas, primary } = workAreas();
    window.setBounds(spotlightBounds(nearestWorkArea(this.#options.cursor(), areas, primary)));
    window.show();
    window.focus();
    this.#sendWhenLoaded(window, PUSH.shown, this.#nextShowing(window));
  }

  /** The remembered place of the Holo (null: default corner). */
  setHoloAnchor(anchor: Point | null): void {
    this.#anchor = anchor;
  }

  /** Shows the Holo (fading in, never taking the focus) or asks it to fade out. */
  setHoloVisible(visible: boolean): void {
    const current = this.#holo;
    if (!visible) {
      if (isAlive(current) && current.isVisible()) this.#requestHide(current);
      return;
    }
    const window = this.#ensureHolo();
    const wasHiding = this.#cancelHide(window);
    if (window.isVisible()) {
      // Shown again while fading out: fade back in.
      if (wasHiding) window.webContents.send(PUSH.shown, this.#nextShowing(window));
      return;
    }
    this.#expanded = false;
    this.#layoutHolo();
    // Never steals the focus from what the person is doing.
    window.showInactive();
    this.#sendWhenLoaded(window, PUSH.shown, this.#nextShowing(window));
  }

  /** Shows the Holo with its mini-chat open (a notification's click: Alicia waits there for an answer). */
  openHoloChat(): void {
    this.setHoloVisible(true);
    const window = this.#holo;
    if (isAlive(window)) this.#sendWhenLoaded(window, PUSH.holoOpenChat);
  }

  /**
   * The drag follows the pointer as the main process sees it on the desktop: the page only says that it moved.
   * Its own screen coordinates would be off when the Holo crosses screens with different scales.
   */
  holoDragStart(): void {
    this.#dragOrigin = this.#holoAnchor();
    this.#dragCursor = this.#options.cursor();
  }

  holoDragMove(): void {
    const origin = this.#dragOrigin;
    const start = this.#dragCursor;
    if (origin === null || start === null) return;
    const cursor = this.#options.cursor();
    const target = { x: Math.round(origin.x + cursor.x - start.x), y: Math.round(origin.y + cursor.y - start.y) };
    const { areas, primary } = workAreas();
    this.#anchor = clampAnchor(target, nearestWorkArea(target, areas, primary));
    this.#layoutHolo();
  }

  /** The place to remember, or null when no drag was going on. */
  holoDragEnd(): Point | null {
    if (this.#dragOrigin === null) return null;
    this.#dragOrigin = null;
    this.#dragCursor = null;
    return this.#holoAnchor();
  }

  setHoloExpanded(expanded: boolean): HoloView {
    this.#expanded = expanded;
    const view = this.#layoutHolo();
    const holo = this.#holo;
    if (expanded && isAlive(holo)) holo.focus();
    return view;
  }

  /**
   * The page finished its exit animation (the Spotlight bar also closes itself, after Enter or Escape). The Holo
   * only hides when the main process asked for it.
   */
  hideSelf(contents: WebContents, showing: number): void {
    const found = this.#all().find(([surface, window]) => surface !== "main" && window.webContents === contents);
    if (found === undefined) return;
    const [surface, window] = found;
    // The page closed an earlier showing: the window was shown again before its request arrived (the shortcut
    // pressed right after Escape). It stays.
    if (showing !== (this.#showings.get(window) ?? 0)) return;
    if (surface === "holo" && !this.#hiding.has(window)) return;
    this.#finishHide(window);
  }

  /** The open windows with their surface. */
  #all(): [Surface, BrowserWindow][] {
    const windows: [Surface, BrowserWindow | null][] = [
      ["main", this.#main], ["holo", this.#holo], ["spotlight", this.#spotlight],
    ];
    return windows.filter((entry): entry is [Surface, BrowserWindow] => isAlive(entry[1]));
  }

  /** Shown, not minimized and in front: an answer arriving behind another app would go unseen. */
  #mainVisible(): boolean {
    const window = this.#main;
    return isAlive(window) && window.isVisible() && !window.isMinimized() && this.#options.isFocused(window);
  }

  /** The Holo's place, brought back onto a screen that still exists. */
  #holoAnchor(): Point {
    const { areas, primary } = workAreas();
    return holoAnchor(this.#anchor, areas, primary);
  }

  /** Places the Holo window; the page is told whenever its layout changes (side flip, screen edge…). */
  #layoutHolo(): HoloView {
    const anchor = this.#holoAnchor();
    const { areas, primary } = workAreas();
    const layout: HoloLayout = holoLayout(anchor, this.#expanded, nearestWorkArea(anchor, areas, primary));
    const view: HoloView = { expanded: this.#expanded, panelSide: layout.panelSide, mascot: layout.mascot };
    const holo = this.#holo;
    if (isAlive(holo)) {
      // Collapsed, the Holo never takes the focus (a drag must not steal it); open, the mini-chat needs it.
      holo.setFocusable(this.#expanded);
      // Explicit size, every time: moving to a screen with another scale must not resize the window.
      holo.setBounds(layout.bounds);
      const json = JSON.stringify(view);
      if (json !== this.#holoView) {
        this.#holoView = json;
        holo.webContents.send(PUSH.holoView, view);
      }
    }
    return view;
  }

  #ensureHolo(): BrowserWindow {
    const existing = this.#holo;
    if (existing !== null && !existing.isDestroyed()) return existing;
    const window = new BrowserWindow({
      ...HOLO_SIZE,
      show: false,
      focusable: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: secureWebPreferences(),
    });
    window.setAlwaysOnTop(true, "floating");
    // A new page has been told nothing yet.
    this.#holoView = null;
    window.on("close", (event) => {
      if (this.#quitting) return;
      event.preventDefault();
      this.#options.onHoloDismissed();
    });
    this.#load(window, "holo");
    this.#holo = window;
    return window;
  }

  #ensureSpotlight(): BrowserWindow {
    const existing = this.#spotlight;
    if (existing !== null && !existing.isDestroyed()) return existing;
    const window = new BrowserWindow({
      ...SPOTLIGHT_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: secureWebPreferences(),
    });
    window.setAlwaysOnTop(true, "pop-up-menu");
    // Like Spotlight: clicking anywhere else closes the bar.
    window.on("blur", () => {
      if (window.isVisible()) this.#requestHide(window);
    });
    window.on("close", (event) => {
      if (this.#quitting) return;
      event.preventDefault();
      this.#requestHide(window);
    });
    this.#load(window, "spotlight");
    this.#spotlight = window;
    return window;
  }

  /** Asks the page to play its exit; it calls hideSelf when done (or the window hides anyway shortly after). */
  #requestHide(window: BrowserWindow): void {
    if (this.#hiding.has(window)) return;
    this.#hiding.set(window, setTimeout(() => {
      this.#finishHide(window);
    }, HIDE_FALLBACK_MS));
    window.webContents.send(PUSH.hideRequest);
  }

  /** True when a fade-out was going on. */
  #cancelHide(window: BrowserWindow): boolean {
    const timer = this.#hiding.get(window);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.#hiding.delete(window);
    return true;
  }

  #finishHide(window: BrowserWindow): void {
    this.#cancelHide(window);
    if (window.isDestroyed()) return;
    window.hide();
    if (window === this.#holo) {
      this.#expanded = false;
      this.#layoutHolo();
    }
  }

  /** A new showing of a floating window: its number goes to the page with PUSH.shown. */
  #nextShowing(window: BrowserWindow): number {
    const showing = (this.#showings.get(window) ?? 0) + 1;
    this.#showings.set(window, showing);
    return showing;
  }

  /** Sends once the page is loaded (a push sent earlier would be lost). */
  #sendWhenLoaded(window: BrowserWindow, channel: string, payload?: unknown): void {
    const contents = window.webContents;
    if (contents.isLoading()) {
      contents.once("did-finish-load", () => {
        contents.send(channel, payload);
      });
    } else {
      contents.send(channel, payload);
    }
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
