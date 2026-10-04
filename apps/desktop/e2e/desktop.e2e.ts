import { expect, test } from "vitest";
import {
  callHook, closeWindow, deferred, GREETING_EVENTS, launch, pair, POLL, recorded, secondInstance, send, startBrain,
  tempDir, windowVisible,
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
