import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  callHook, closeWindow, deferred, exited, GREETING_EVENTS, launch, pair, POLL, recorded, secondInstance, send, startBrain,
  surfacePage, tempDir, windowBounds, windowVisible,
} from "./support.ts";

test("closing the main window hides it in the tray; launching Alicia again brings it back", async () => {
  const userData = tempDir("alicia-e2e-profile-");
  const { app } = await launch(userData);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);

  await closeWindow(app, "main");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(false);
  // Still running: the main process answers.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);

  // A second launch at login (`--hidden`) gives way without showing anything.
  expect(await secondInstance(userData, ["--hidden"])).toBe(0);
  expect(await windowVisible(app, "main")).toBe(false);

  // A second launch on the same profile gives way to the first one, which shows itself.
  expect(await secondInstance(userData)).toBe(0);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
});

test("started at login (--hidden), Alicia waits in the notification area", async () => {
  const { app } = await launch(tempDir("alicia-e2e-profile-"), {}, ["--hidden"]);
  await expect.poll(async () => (await recorded(app)).tray.length, POLL).toBeGreaterThan(0);
  // Give the window every chance to show itself by mistake.
  await surfacePage(app, "main");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await windowVisible(app, "main")).toBe(false);
  await callHook(app, "trayClick");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
});

test("Quitter Alicia in the tray menu really quits", async () => {
  const { app } = await launch(tempDir("alicia-e2e-profile-"));
  const gone = exited(app);
  // The app may quit before the call returns.
  await callHook(app, "trayAction", "quit").catch(() => undefined);
  await gone;
});

test("when Windows ends the session, Alicia lets go of the OS and lets its windows close", async () => {
  const { app } = await launch(tempDir("alicia-e2e-profile-"));
  await expect.poll(async () => (await recorded(app)).shortcuts, POLL).toEqual(["Ctrl+Alt+A"]);
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const url = window.webContents.getURL();
      if (URL.canParse(url) && new URL(url).searchParams.get("surface") === "main") window.emit("session-end", {});
    }
  });
  const state = await recorded(app);
  expect([state.shortcuts, state.tray]).toEqual([[], []]);
  // The close button now closes for real (no more hiding in the tray).
  await closeWindow(app, "main");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => {
    const url = window.webContents.getURL();
    return URL.canParse(url) && new URL(url).searchParams.get("surface") === "main";
  })), POLL).toBe(false);
});

const SavedStartup = z.object({ launchAtStartup: z.boolean() });

test("every page the app creates is locked down: no navigation, no webview", async () => {
  const { app } = await launch(tempDir("alicia-e2e-profile-"));
  const guards = await app.evaluate(({ BrowserWindow }) => {
    const stray = new BrowserWindow({ show: false });
    const contents = stray.webContents;
    const counts = ["will-navigate", "will-frame-navigate", "will-attach-webview"].map((name) => contents.listenerCount(name));
    stray.destroy();
    return counts;
  });
  expect(guards.every((count) => count > 0)).toBe(true);
});

test("at start Windows wins over the saved launch-at-startup choice", async () => {
  const userData = tempDir("alicia-e2e-profile-");
  const file = join(userData, "settings.json");
  writeFileSync(file, JSON.stringify({ launchAtStartup: true }));
  // The recorder stands for a Windows profile without Alicia's login item (removed in the startup apps).
  const { app } = await launch(userData);
  await expect.poll(async () => (await recorded(app)).tray.find((item) => item.id === "toggle-startup")?.checked, POLL)
    .toBe(false);
  expect((await recorded(app)).loginItem).toBeNull();
  await expect.poll(() => SavedStartup.parse(JSON.parse(readFileSync(file, "utf8"))).launchAtStartup, POLL).toBe(false);
});

test("the tray menu opens Alicia and switches launch at startup", async () => {
  const { app } = await launch(tempDir("alicia-e2e-profile-"));
  expect((await recorded(app)).tray.map((item) => item.label)).toEqual([
    "Ouvrir Alicia", "Afficher l'Holo", "Lancer au démarrage", "Quitter Alicia",
  ]);
  // Nothing is written to Windows at start: only an explicit change writes the login item.
  expect((await recorded(app)).loginItem).toBeNull();

  await callHook(app, "trayAction", "toggle-startup");
  await expect.poll(async () => (await recorded(app)).loginItem, POLL).toBe(true);
  expect((await recorded(app)).tray.find((item) => item.id === "toggle-startup")?.checked).toBe(true);

  await closeWindow(app, "main");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(false);
  await callHook(app, "trayClick");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
  await closeWindow(app, "main");
  await callHook(app, "trayAction", "open");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
});

test("an answer arriving while the window is hidden becomes a notification that brings it back", async () => {
  const gate = deferred();
  const brain = await startBrain(() => GREETING_EVENTS, async () => {
    await gate.promise;
    return GREETING_EVENTS;
  });
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  // The person looks at the window, whatever the OS focus of the test machine.
  await callHook(app, "pinFocus", "focused");
  await pair(page, brain);

  // Window visible: no notification.
  await send(page, "Salut");
  await page.getByTestId("message-assistant").filter({ hasText: "je suis là !" }).waitFor();
  expect((await recorded(app)).notifications).toEqual([]);

  // Hidden while Alicia answers: notification, whose click shows the window again.
  await send(page, "Tu es toujours là ?");
  await page.getByTestId("message-user").filter({ hasText: "Tu es toujours là ?" }).waitFor();
  await closeWindow(app, "main");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(false);
  gate.resolve();
  await expect.poll(async () => (await recorded(app)).notifications, POLL).toEqual([
    { title: "Alicia", body: "Bonjour Kévin, je suis là !" },
  ]);
  await callHook(app, "clickNotification", 0);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
  await expect.poll(() => page.getByTestId("message-assistant").count(), POLL).toBe(2);
});

test("a tray change that cannot be saved says so in a notification, and changes nothing", async () => {
  const userData = tempDir("alicia-e2e-profile-");
  // A folder where settings.json should be: the settings can be read (defaults) but never written.
  mkdirSync(join(userData, "settings.json"));
  const { app } = await launch(userData);
  await callHook(app, "trayAction", "toggle-startup");
  await expect.poll(async () => (await recorded(app)).notifications, POLL).toEqual([
    { title: "Alicia", body: "Impossible d'enregistrer ce réglage pour l'instant." },
  ]);
  expect((await recorded(app)).loginItem).toBeNull();
  expect((await recorded(app)).tray.find((item) => item.id === "toggle-startup")?.checked).toBe(false);
});

test("Holo: follows Alicia's mood, opens a mini-chat, hides from the tray, and keeps its place", async () => {
  const gate = deferred();
  const brain = await startBrain(async () => {
    await gate.promise;
    return GREETING_EVENTS;
  });
  const userData = tempDir("alicia-e2e-profile-");
  const { app, page } = await launch(userData);
  // The main window is in front, whatever the OS focus of the test machine: its own answer is no notification.
  await callHook(app, "pinFocus", "focused");
  await pair(page, brain);

  const holo = await surfacePage(app, "holo");
  /** The mascot's top-left corner on the desktop. */
  const mascotOnScreen = async (): Promise<{ x: number; y: number }> => {
    const bounds = await windowBounds(app, "holo");
    const box = await holo.getByTestId("holo-mascot").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    });
    return { x: bounds.x + Math.round(box.x), y: bounds.y + Math.round(box.y) };
  };
  await expect.poll(() => windowVisible(app, "holo"), POLL).toBe(true);
  const mood = (): Promise<string | null> => holo.getByTestId("holo-mascot").getByTestId("mascot").getAttribute("data-mood");
  await expect.poll(mood, POLL).toBe("idle");

  // A turn from the main window: the Holo thinks, then celebrates, then rests.
  await send(page, "Salut");
  await expect.poll(mood, POLL).toBe("thinking");
  gate.resolve();
  await expect.poll(mood, POLL).toBe("success");
  await expect.poll(mood, POLL).toBe("idle");

  // A click opens the mini-chat, which talks to the same Alicia; the mascot does not move.
  const restingPlace = await mascotOnScreen();
  await holo.getByTestId("holo-mascot").click();
  await holo.getByTestId("holo-chat").waitFor();
  expect((await windowBounds(app, "holo")).width).toBeGreaterThan(400);
  expect(await mascotOnScreen()).toEqual(restingPlace);
  await expect.poll(() => holo.getByTestId("holo-input").isEnabled(), POLL).toBe(true);
  await holo.getByTestId("holo-input").fill("Et toi ?");
  await holo.getByTestId("holo-input").press("Enter");
  await holo.getByTestId("holo-message-assistant").filter({ hasText: "je suis là !" }).waitFor();
  // Its answer reached the open mini-chat: no notification, and the main window never showed it.
  expect((await recorded(app)).notifications).toEqual([]);
  expect(await page.getByTestId("message-user").allTextContents()).toEqual(["Salut"]);

  // Dragged, open, to the far left of the screen: the mini-chat moves to the mascot's right.
  await expect.poll(() => holo.locator(".panel.left").count(), POLL).toBe(1);
  await callHook(app, "moveCursor", { x: 0, y: 0 });
  await holo.evaluate(() => window.alicia.holo.dragStart());
  await callHook(app, "moveCursor", { x: -20_000, y: 0 });
  await holo.evaluate(() => window.alicia.holo.dragMove());
  await holo.evaluate(() => window.alicia.holo.dragEnd());
  await expect.poll(() => holo.locator(".panel.right").count(), POLL).toBe(1);

  await holo.getByTestId("holo-chat-close").click();
  await holo.getByTestId("holo-chat").waitFor({ state: "detached" });
  await expect.poll(async () => (await windowBounds(app, "holo")).width, POLL).toBe(136);

  // Moved by hand, following the pointer the main process sees (the click-or-drag gesture is unit-tested).
  const before = await windowBounds(app, "holo");
  await callHook(app, "moveCursor", { x: 500, y: 500 });
  await holo.evaluate(() => window.alicia.holo.dragStart());
  await callHook(app, "moveCursor", { x: 800, y: 300 });
  await holo.evaluate(() => window.alicia.holo.dragMove());
  await holo.evaluate(() => window.alicia.holo.dragEnd());
  const moved = await windowBounds(app, "holo");
  expect(moved).toMatchObject({ x: before.x + 300, y: before.y - 200 });

  // Hidden and shown again from the tray.
  await callHook(app, "trayAction", "toggle-holo");
  await expect.poll(() => windowVisible(app, "holo"), POLL).toBe(false);
  await callHook(app, "trayAction", "toggle-holo");
  await expect.poll(() => windowVisible(app, "holo"), POLL).toBe(true);
  await app.close();

  // Its place is remembered.
  const again = await launch(userData);
  await surfacePage(again.app, "holo");
  await expect.poll(() => windowVisible(again.app, "holo"), POLL).toBe(true);
  expect(await windowBounds(again.app, "holo")).toEqual(moved);
});

test("Spotlight: the shortcut opens the bar, Enter sends, the answer comes back as a notification", async () => {
  const brain = await startBrain();
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  expect((await recorded(app)).shortcuts).toEqual(["Ctrl+Alt+A"]);
  await closeWindow(app, "main");
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(false);

  await callHook(app, "triggerShortcut");
  const bar = await surfacePage(app, "spotlight");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(true);
  const input = bar.getByTestId("spotlight-input");
  await expect.poll(() => input.evaluate((element) => element === document.activeElement), POLL).toBe(true);
  await input.fill("Quel temps fait-il ?");
  await input.press("Enter");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(false);

  await expect.poll(async () => (await recorded(app)).notifications, POLL).toEqual([
    { title: "Alicia", body: "Bonjour Kévin, je suis là !" },
  ]);
  // The notification opens the main window on that conversation.
  await callHook(app, "clickNotification", 0);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
  await page.getByTestId("message-user").filter({ hasText: "Quel temps fait-il ?" }).waitFor();
  await page.getByTestId("conversation-list").getByText("Quel temps fait-il ?").waitFor();
});

test("Spotlight: Escape closes the bar without sending, and it opens again empty", async () => {
  const brain = await startBrain();
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  await callHook(app, "triggerShortcut");
  const bar = await surfacePage(app, "spotlight");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(true);
  // The bar never needs the device token: it only knows whether Alicia is paired.
  await expect(bar.evaluate(() => window.alicia.getSession())).rejects.toThrow();
  expect(await bar.evaluate(() => window.alicia.paired())).toBe(true);
  await bar.getByTestId("spotlight-input").fill("Rien du tout");
  await bar.getByTestId("spotlight-input").press("Escape");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(false);
  expect(brain.engine.requests).toHaveLength(0);

  await callHook(app, "triggerShortcut");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(true);
  await expect.poll(() => bar.getByTestId("spotlight-input").inputValue(), POLL).toBe("");
});

test("Réglages: shortcut, launch at startup and Holo are kept after a restart; sign out lives here", async () => {
  const brain = await startBrain();
  const userData = tempDir("alicia-e2e-profile-");
  const first = await launch(userData);
  await pair(first.page, brain);
  await first.page.getByTestId("nav-settings").click();
  await first.page.getByTestId("settings-view").waitFor();
  await expect.poll(() => first.page.getByTestId("titlebar-title").textContent(), POLL).toBe("Réglages");
  await expect.poll(() => first.page.getByTestId("settings-server").textContent(), POLL).toBe(brain.url);
  await expect.poll(() => first.page.getByTestId("settings-shortcut").textContent(), POLL).toBe("Ctrl+Alt+A");

  // A new shortcut, typed on the keyboard.
  await first.page.getByTestId("settings-shortcut-change").click();
  await first.page.getByTestId("settings-shortcut-capture").waitFor();
  // While a new one is typed, the current shortcut is set aside (pressing it must not open Spotlight).
  await expect.poll(async () => (await recorded(first.app)).shortcuts, POLL).toEqual([]);
  await first.page.keyboard.press("Escape");
  await expect.poll(async () => (await recorded(first.app)).shortcuts, POLL).toEqual(["Ctrl+Alt+A"]);
  await expect.poll(() => first.page.getByTestId("settings-shortcut-change").evaluate((element) => element === document.activeElement), POLL).toBe(true);
  await first.page.getByTestId("settings-shortcut-change").click();
  await first.page.getByTestId("settings-shortcut-capture").waitFor();
  // A bare letter is explained under the shortcut.
  await first.page.keyboard.press("k");
  await first.page.getByTestId("settings-shortcut-error").waitFor();
  await first.page.keyboard.press("Control+Shift+K");
  await expect.poll(() => first.page.getByTestId("settings-shortcut").textContent(), POLL).toBe("Ctrl+Shift+K");
  expect((await recorded(first.app)).shortcuts).toEqual(["Ctrl+Shift+K"]);

  await first.page.getByTestId("settings-startup").click();
  await expect.poll(() => first.page.getByTestId("settings-startup").getAttribute("aria-checked"), POLL).toBe("true");
  expect((await recorded(first.app)).loginItem).toBe(true);

  await expect.poll(() => windowVisible(first.app, "holo"), POLL).toBe(true);
  await first.page.getByTestId("settings-holo").click();
  await expect.poll(() => windowVisible(first.app, "holo"), POLL).toBe(false);
  await first.app.close();

  const second = await launch(userData);
  await second.page.getByTestId("nav-settings").click();
  await expect.poll(() => second.page.getByTestId("settings-shortcut").textContent(), POLL).toBe("Ctrl+Shift+K");
  expect(await second.page.getByTestId("settings-startup").getAttribute("aria-checked")).toBe("true");
  expect(await second.page.getByTestId("settings-holo").getAttribute("aria-checked")).toBe("false");
  expect((await recorded(second.app)).shortcuts).toEqual(["Ctrl+Shift+K"]);
  expect(await windowVisible(second.app, "holo")).toBe(false);

  // Development build: updates only exist in the installed app.
  await expect.poll(() => second.page.getByTestId("settings-updates").textContent(), POLL).toContain("app installée");

  // Signing out is in Réglages now.
  await second.page.getByTestId("sign-out").click();
  await second.page.getByTestId("sign-out-yes").click();
  await second.page.getByTestId("pairing-code").waitFor();
});

test("first launch: the brain found on the network fills the address", async () => {
  const brain = await startBrain();
  const found = JSON.stringify([{ name: "Alicia sur test", url: brain.url, version: "0.1.0" }]);
  const { page } = await launch(tempDir("alicia-e2e-profile-"), { ALICIA_TEST_BRAINS: found });
  await page.getByTestId("discovered-brain").filter({ hasText: "Alicia sur test" }).waitFor();
  await expect.poll(() => page.getByTestId("pairing-server").inputValue(), POLL).toBe(brain.url);
  await page.getByTestId("pairing-code").fill(brain.app.pairing.generateCode("kevin"));
  await page.getByTestId("pairing-submit").click();
  await page.getByTestId("chat-welcome").waitFor();
});

test("nothing found on the network: the manual address stays, with a hint for Tailscale", async () => {
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await page.getByTestId("discovery-searching").waitFor();
  await page.getByTestId("discovery-none").filter({ hasText: "Tailscale" }).waitFor();
  expect(await page.getByTestId("pairing-server").inputValue()).toBe("http://127.0.0.1:8780");
  // Only the pairing screen (main window) may search the network.
  const bar = await surfacePage(app, "spotlight");
  await expect(bar.evaluate(() => window.alicia.discovery.start())).rejects.toThrow();
  // Nor change settings, nor sign the device out.
  await expect(bar.evaluate(() => window.alicia.settings.update({ showHolo: false }))).rejects.toThrow();
  await expect(bar.evaluate(() => window.alicia.clearSession())).rejects.toThrow();
});
