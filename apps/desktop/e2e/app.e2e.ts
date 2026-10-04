import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright";
import { afterEach, expect, test } from "vitest";
import { type Application, buildApplication } from "../../brain/src/application.ts";
import { parseConfig } from "../../brain/src/config.ts";
import { FakeEngine } from "../../brain/src/engine/fake-engine.ts";
import { FakeEmbedder } from "../../brain/src/memory/fake-embedder.ts";

const MAIN = fileURLToPath(new URL("../out/main/index.js", import.meta.url));

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
const POLL = { timeout: 15_000, interval: 50 };

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return dir;
}

interface Brain {
  readonly engine: FakeEngine;
  readonly url: string;
  /** The running application (replaced by `restart`). */
  app: Application;
  stop: () => Promise<void>;
  /** Starts a fresh application on the same data and the same port. */
  restart: () => Promise<void>;
}

/** A real brain on a free local port, with a fake engine that answers instantly. */
async function startBrain(): Promise<Brain> {
  const dataDir = tempDir("alicia-e2e-brain-");
  const config = parseConfig(`
dataDir: ${JSON.stringify(dataDir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const engine = new FakeEngine(() => [
    { type: "session", sessionId: "s1" },
    { type: "text", text: "Bonjour Kévin, " },
    { type: "text", text: "je suis là !" },
    { type: "done", inputTokens: 1, outputTokens: 2 },
  ]);
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

async function launch(userData: string): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RENDERER_URL") env[key] = value;
  }
  env["ALICIA_USER_DATA"] = userData;
  const app = await electron.launch({ args: [MAIN], env });
  cleanups.push(async () => {
    await app.close();
  });
  return app.firstWindow();
}

/** Pairs the app with the brain, typing the code the way a person reads it (with a space). */
async function pair(page: Page, brain: Brain): Promise<void> {
  const code = brain.app.pairing.generateCode("kevin");
  await page.getByTestId("pairing-server").fill(brain.url);
  await page.getByTestId("pairing-code").fill(`${code.slice(0, 3)} ${code.slice(3)}`);
  await expect.poll(() => page.getByTestId("pairing-code").inputValue(), POLL).toBe(code);
  await page.getByTestId("pairing-submit").click();
  await page.getByTestId("chat-welcome").waitFor();
  // The welcome screen shows before the socket is ready: wait until the composer accepts messages.
  await expect.poll(() => page.getByTestId("composer-input").isEnabled(), POLL).toBe(true);
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
}

/** Waits until the `count`-th answer is complete (the typing caret is gone). */
async function answered(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.getByTestId("message-assistant").count(), POLL).toBe(count);
  await expect.poll(() => page.locator(".caret").count(), POLL).toBe(0);
}

test("pair, chat with streaming, use Opus, then find the conversation again after a restart", async () => {
  const brain = await startBrain();
  const userData = tempDir("alicia-e2e-profile-");

  const first = await launch(userData);
  await pair(first, brain);
  await first.getByTestId("chat-welcome").filter({ hasText: "Kévin, on fait quoi ?" }).waitFor();

  await send(first, "Salut Alicia");
  await first.getByTestId("message-user").filter({ hasText: "Salut Alicia" }).waitFor();
  await first.getByTestId("message-assistant").filter({ hasText: "Bonjour Kévin, je suis là !" }).waitFor();
  await first.getByTestId("conversation-list").getByText("Salut Alicia").waitFor();
  await expect.poll(() => first.getByTestId("mascot").last().getAttribute("data-mood"), POLL).toMatch(/^(success|idle)$/);

  await first.getByTestId("composer-opus").click();
  await expect.poll(() => first.getByTestId("composer-opus").getAttribute("aria-pressed"), POLL).toBe("true");
  await send(first, "Et ensuite ?");
  await answered(first, 2);
  expect(brain.engine.requests.map((request) => request.model)).toEqual(["sonnet", "opus"]);
  await first.close();

  // The session survives a restart: straight to the chat, history reloadable.
  const second = await launch(userData);
  await second.getByTestId("chat-welcome").waitFor();
  expect(await second.getByTestId("pairing-code").count()).toBe(0);
  await second.getByTestId("conversation-list").getByText("Salut Alicia").click();
  await expect.poll(() => second.getByTestId("message-user").allTextContents(), POLL).toEqual(["Salut Alicia", "Et ensuite ?"]);
  await second.getByTestId("message-assistant").filter({ hasText: "je suis là !" }).first().waitFor();
});

test("a wrong pairing code is explained", async () => {
  const brain = await startBrain();
  const page = await launch(tempDir("alicia-e2e-profile-"));
  await page.getByTestId("pairing-server").fill(brain.url);
  await page.getByTestId("pairing-code").fill("000000");
  await page.getByTestId("pairing-submit").click();
  await page.getByTestId("pairing-error").filter({ hasText: "Code invalide" }).waitFor();
  await page.getByTestId("pairing-code").waitFor();
});

test("a sent message is brought to the top of the messages area", async () => {
  const brain = await startBrain();
  const page = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);

  const userBubbleOffset = (): Promise<number> =>
    page.evaluate(() => {
      const area = document.querySelector("[data-testid=messages]");
      const bubble = [...(area?.querySelectorAll("[data-testid=message-user]") ?? [])].at(-1);
      if (area === null || bubble === undefined) return Number.NaN;
      return bubble.getBoundingClientRect().top - area.getBoundingClientRect().top;
    });

  for (const [index, text] of ["Premier message", "Deuxième message"].entries()) {
    await send(page, text);
    await answered(page, index + 1);
    // The scroll is smooth: wait for it to settle at the top of the area.
    await expect.poll(userBubbleOffset, POLL).toBeGreaterThanOrEqual(0);
    await expect.poll(userBubbleOffset, POLL).toBeLessThanOrEqual(16);
  }
});

test("the app shows when the brain is away and recovers when it is back", async () => {
  const brain = await startBrain();
  const page = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  await expect.poll(() => page.getByTestId("connection-status").count(), POLL).toBe(0);

  await brain.stop();
  await page.getByTestId("connection-status").filter({ hasText: "Hors ligne, reconnexion…" }).waitFor();
  await expect.poll(() => page.getByTestId("composer-input").isDisabled(), POLL).toBe(true);

  await brain.restart();
  await expect.poll(() => page.getByTestId("connection-status").count(), { ...POLL, timeout: 30_000 }).toBe(0);
  await expect.poll(() => page.getByTestId("composer-input").isEnabled(), POLL).toBe(true);
  await send(page, "Après la coupure");
  await answered(page, 1);
  await page.getByTestId("message-assistant").filter({ hasText: "je suis là !" }).waitFor();
});

test("a revoked device goes back to pairing with an explanation", async () => {
  const brain = await startBrain();
  const page = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);

  const active = brain.app.pairing.listDevices().filter((device) => device.revokedAt === null);
  expect(active).toHaveLength(1);
  expect(brain.app.pairing.revokeDevice(active[0]?.id ?? "")).toBe(true);

  await send(page, "Tu m'entends ?");
  await page.getByTestId("pairing-code").waitFor();
  await page.getByTestId("pairing-notice").filter({ hasText: "déconnecté" }).waitFor();
});
