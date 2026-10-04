import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, expect } from "vitest";
import { type Application, buildApplication } from "../../brain/src/application.ts";
import { parseConfig } from "../../brain/src/config.ts";
import type { EngineEvent } from "../../brain/src/engine/engine.ts";
import { FakeEngine, type Scenario } from "../../brain/src/engine/fake-engine.ts";
import { FakeEmbedder } from "../../brain/src/memory/fake-embedder.ts";
import { RecordedState, TEST_HOOKS_KEY } from "../src/main/recording-os.ts";
import type { Surface } from "../src/shared/surface.ts";

export const MAIN = fileURLToPath(new URL("../out/main/index.js", import.meta.url));

/** Cleanups registered by the running test; each is best effort (Windows keeps files locked a little). */
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()?.();
    } catch {
      // A temporary directory left behind is harmless.
    }
  }
});

/** Poll options: the default of one second is too short for an app that animates and reconnects. */
export const POLL = { timeout: 15_000, interval: 50 };

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return dir;
}

export interface Brain {
  readonly engine: FakeEngine;
  readonly url: string;
  /** The running application (replaced by `restart`). */
  app: Application;
  stop: () => Promise<void>;
  /** Starts a fresh application on the same data and the same port. */
  restart: () => Promise<void>;
}

export const GREETING_EVENTS: readonly EngineEvent[] = [
  { type: "session", sessionId: "s1" },
  { type: "text", text: "Bonjour Kévin, " },
  { type: "text", text: "je suis là !" },
  { type: "done", inputTokens: 1, outputTokens: 2 },
];
export const GREETING: Scenario = () => GREETING_EVENTS;

/**
 * A real brain on a free local port (never 8780), with a fake engine that answers instantly (by default, a
 * greeting). With several scenarios, the n-th request plays the n-th one (the last one repeats).
 */
export async function startBrain(...scenarios: Scenario[]): Promise<Brain> {
  const dataDir = tempDir("alicia-e2e-brain-");
  const config = parseConfig(`
dataDir: ${JSON.stringify(dataDir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const engine = new FakeEngine(...(scenarios.length > 0 ? scenarios : [GREETING]));
  const first = await buildApplication(config, engine, { embedder: new FakeEmbedder() });
  await first.server.listen({ port: 0, host: "127.0.0.1" });
  const port = (first.server.server.address() as AddressInfo).port;
  let running = true;
  const brain: Brain = {
    engine,
    url: `http://127.0.0.1:${port}`,
    app: first,
    stop: async () => {
      if (!running) return;
      running = false;
      await brain.app.close();
    },
    restart: async () => {
      await brain.stop();
      brain.app = await buildApplication(config, engine, { embedder: new FakeEmbedder() });
      await brain.app.server.listen({ port, host: "127.0.0.1" });
      running = true;
    },
  };
  cleanups.push(() => brain.stop());
  return brain;
}

/** The app's environment in tests: its own profile, and nothing that reaches the OS (see ALICIA_OS_INTEGRATION). */
export function appEnv(userData: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RENDERER_URL") env[key] = value;
  }
  return { ...env, ALICIA_USER_DATA: userData, ALICIA_OS_INTEGRATION: "off", ...extra };
}

export interface Launched {
  app: ElectronApplication;
  /** The main window. */
  page: Page;
}

export async function launch(userData: string, extraEnv: Readonly<Record<string, string>> = {}): Promise<Launched> {
  const app = await electron.launch({ args: [MAIN], env: appEnv(userData, extraEnv) });
  cleanups.push(async () => {
    await app.close();
  });
  return { app, page: await surfacePage(app, "main") };
}

function surfaceOfUrl(url: string): string | null {
  return URL.canParse(url) ? new URL(url).searchParams.get("surface") : null;
}

/** The page of one surface (main window, Holo or Spotlight bar), once its window exists. */
export async function surfacePage(app: ElectronApplication, surface: Surface): Promise<Page> {
  const deadline = Date.now() + POLL.timeout;
  for (;;) {
    const found = app.windows().find((page) => surfaceOfUrl(page.url()) === surface);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`No ${surface} window`);
    await new Promise((resolve) => setTimeout(resolve, POLL.interval));
  }
}

/** Whether the window of that surface is shown (read in the main process). */
export function windowVisible(app: ElectronApplication, surface: Surface): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, wanted) =>
    BrowserWindow.getAllWindows().some((window) => {
      const url = window.webContents.getURL();
      return window.isVisible() && URL.canParse(url) && new URL(url).searchParams.get("surface") === wanted;
    }), surface);
}

export function windowBounds(app: ElectronApplication, surface: Surface): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }, wanted) => {
    const found = BrowserWindow.getAllWindows().find((window) => {
      const url = window.webContents.getURL();
      return URL.canParse(url) && new URL(url).searchParams.get("surface") === wanted;
    });
    if (found === undefined) throw new Error(`No ${wanted} window`);
    return found.getBounds();
  }, surface);
}

/** Closes a window the way its close button would (the main window then hides in the tray). */
export async function closeWindow(app: ElectronApplication, surface: Surface): Promise<void> {
  await app.evaluate(({ BrowserWindow }, wanted) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const url = window.webContents.getURL();
      if (URL.canParse(url) && new URL(url).searchParams.get("surface") === wanted) window.close();
    }
  }, surface);
}

export type HookName = "state" | "occupy" | "triggerShortcut" | "clickNotification" | "trayAction" | "trayClick";

/** Calls one of RecordingOs's test hooks in the main process. */
export function callHook(app: ElectronApplication, name: HookName, argument?: number | string): Promise<unknown> {
  return app.evaluate((_electron, [key, hook, arg]) => {
    const hooks: unknown = Reflect.get(globalThis, key);
    if (typeof hooks !== "object" || hooks === null) throw new Error("No test hooks: is ALICIA_OS_INTEGRATION=off?");
    const run: unknown = Reflect.get(hooks, hook);
    if (typeof run !== "function") throw new Error(`Unknown test hook ${hook}`);
    const result: unknown = Reflect.apply(run, hooks, arg === undefined ? [] : [arg]);
    return result;
  }, [TEST_HOOKS_KEY, name, argument] as const);
}

/** What the app asked of the OS so far (shortcuts, login item, notifications, tray menu). */
export async function recorded(app: ElectronApplication): Promise<RecordedState> {
  return RecordedState.parse(await callHook(app, "state"));
}

const electronBinary: unknown = createRequire(import.meta.url)("electron");

/** Starts Alicia again on the same profile, like a second click on its shortcut; resolves with its exit code. */
export function secondInstance(userData: string): Promise<number | null> {
  if (typeof electronBinary !== "string") throw new Error("Electron binary not found");
  const child = spawn(electronBinary, [MAIN], { env: appEnv(userData), stdio: "ignore" });
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => {
      resolve(code);
    });
    child.once("error", reject);
  });
}

/** A gate a fake engine scenario can wait on. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Pairs the app with the brain, typing the code the way a person reads it (with a space). */
export async function pair(page: Page, brain: Brain): Promise<void> {
  const code = brain.app.pairing.generateCode("kevin");
  await page.getByTestId("pairing-server").fill(brain.url);
  await page.getByTestId("pairing-code").fill(`${code.slice(0, 3)} ${code.slice(3)}`);
  await expect.poll(() => page.getByTestId("pairing-code").inputValue(), POLL).toBe(code);
  await page.getByTestId("pairing-submit").click();
  await page.getByTestId("chat-welcome").waitFor();
  // The welcome screen shows before the connection is ready: wait until the composer accepts messages.
  await expect.poll(() => page.getByTestId("composer-input").isEnabled(), POLL).toBe(true);
}

export async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
}

/** Waits until the `count`-th answer is complete (the typing caret is gone). */
export async function answered(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.getByTestId("message-assistant").count(), POLL).toBe(count);
  await expect.poll(() => page.locator(".caret").count(), POLL).toBe(0);
}
