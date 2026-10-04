import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  callHook, closeWindow, deferred, GREETING_EVENTS, launch, pair, POLL, recorded, secondInstance, send, startBrain,
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

  // A second launch on the same profile gives way to the first one, which shows itself.
  expect(await secondInstance(userData)).toBe(0);
  await expect.poll(() => windowVisible(app, "main"), POLL).toBe(true);
});

test("the tray menu opens Alicia and switches launch at startup", async () => {
  const { app } = await launch(tempDir("alicia-e2e-profile-"));
  expect((await recorded(app)).tray.map((item) => item.label)).toEqual([
    "Ouvrir Alicia", "Afficher l'Holo", "Lancer au démarrage", "Quitter Alicia",
  ]);
  // The saved choice (off by default) is applied at start.
  expect((await recorded(app)).loginItem).toBe(false);

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
  expect((await recorded(app)).loginItem).toBe(false);
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
  await pair(page, brain);

  const holo = await surfacePage(app, "holo");
  await expect.poll(() => windowVisible(app, "holo"), POLL).toBe(true);
  const mood = (): Promise<string | null> => holo.getByTestId("holo-mascot").getByTestId("mascot").getAttribute("data-mood");
  await expect.poll(mood, POLL).toBe("idle");

  // A turn from the main window: the Holo thinks, then celebrates, then rests.
  await send(page, "Salut");
  await expect.poll(mood, POLL).toBe("thinking");
  gate.resolve();
  await expect.poll(mood, POLL).toBe("success");
  await expect.poll(mood, POLL).toBe("idle");

  // A click opens the mini-chat, which talks to the same Alicia.
  await holo.getByTestId("holo-mascot").click();
  await holo.getByTestId("holo-chat").waitFor();
  expect((await windowBounds(app, "holo")).width).toBeGreaterThan(400);
  await expect.poll(() => holo.getByTestId("holo-input").isEnabled(), POLL).toBe(true);
  await holo.getByTestId("holo-input").fill("Et toi ?");
  await holo.getByTestId("holo-input").press("Enter");
  await holo.getByTestId("holo-message-assistant").filter({ hasText: "je suis là !" }).waitFor();
  // Its answer reached the open mini-chat: no notification, and the main window never showed it.
  expect((await recorded(app)).notifications).toEqual([]);
  expect(await page.getByTestId("message-user").allTextContents()).toEqual(["Salut"]);
  await holo.getByTestId("holo-chat-close").click();
  await holo.getByTestId("holo-chat").waitFor({ state: "detached" });
  await expect.poll(async () => (await windowBounds(app, "holo")).width, POLL).toBe(136);

  // Moved by hand (the drag itself is unit-tested), hidden and shown again from the tray.
  await holo.evaluate(async () => {
    await window.alicia.holo.dragStart();
    await window.alicia.holo.dragTo({ dx: -300, dy: -200 });
    await window.alicia.holo.dragEnd();
  });
  const moved = await windowBounds(app, "holo");
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
  await bar.getByTestId("spotlight-input").fill("Rien du tout");
  await bar.getByTestId("spotlight-input").press("Escape");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(false);
  expect(brain.engine.requests).toHaveLength(0);

  await callHook(app, "triggerShortcut");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(true);
  await expect.poll(() => bar.getByTestId("spotlight-input").inputValue(), POLL).toBe("");
});
