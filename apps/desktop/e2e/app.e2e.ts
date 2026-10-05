import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { expect, test } from "vitest";
import { callTool, type Scenario } from "../../brain/src/engine/fake-engine.ts";
import { FakeGoogle } from "../../brain/src/google/fake-google.ts";
import {
  answered, callHook, launch, pair, playGoogleConsent, POLL, recorded, RUNNING, send, startBrain, startForgettingBrain, startGoogleBrain,
  surfacePage, tempDir, windowVisible,
} from "./support.ts";

test("pair, chat with streaming, use Opus, then find the conversation again after a restart", async () => {
  const brain = await startBrain();
  const userData = tempDir("alicia-e2e-profile-");

  const { app: firstApp, page: first } = await launch(userData);
  await pair(first, brain);
  await first.getByTestId("chat-welcome").filter({ hasText: "Kévin, on fait quoi ?" }).waitFor();

  await send(first, "Salut Alicia");
  await first.getByTestId("message-user").filter({ hasText: "Salut Alicia" }).waitFor();
  await first.getByTestId("message-assistant").filter({ hasText: "Bonjour Kévin, je suis là !" }).waitFor();
  await first.getByTestId("conversation-list").getByText("Salut Alicia").waitFor();
  await expect.poll(() => first.getByTestId("mascot").last().getAttribute("data-mood"), POLL).toMatch(/^(success|idle)$/);

  await first.getByTestId("composer-opus").click();
  await expect.poll(() => first.getByTestId("composer-opus").getAttribute("aria-checked"), POLL).toBe("true");
  await send(first, "Et ensuite ?");
  await answered(first, 2);
  // « Réfléchir » applies to one message only.
  await expect.poll(() => first.getByTestId("composer-opus").getAttribute("aria-checked"), POLL).toBe("false");
  expect(brain.engine.requests.map((request) => request.model)).toEqual(["sonnet", "opus"]);
  // Closing the window would only hide it in the notification area: quit the app.
  await firstApp.close();

  // The session survives a restart: straight to the chat, history reloadable.
  const { page: second } = await launch(userData);
  await second.getByTestId("chat-welcome").waitFor();
  expect(await second.getByTestId("pairing-code").count()).toBe(0);
  await second.getByTestId("conversation-list").getByText("Salut Alicia").click();
  await expect.poll(() => second.getByTestId("message-user").allTextContents(), POLL).toEqual(["Salut Alicia", "Et ensuite ?"]);
  await second.getByTestId("message-assistant").filter({ hasText: "je suis là !" }).first().waitFor();
});

test("a wrong pairing code is explained", async () => {
  const brain = await startBrain();
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await page.getByTestId("pairing-server").fill(brain.url);
  await page.getByTestId("pairing-code").fill("000000");
  await page.getByTestId("pairing-submit").click();
  await page.getByTestId("pairing-error").filter({ hasText: "Code invalide" }).waitFor();
  await page.getByTestId("pairing-code").waitFor();
});

test("a sent message is brought to the top of the messages area", async () => {
  const brain = await startBrain();
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
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
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
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
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);

  const active = brain.app.pairing.listDevices().filter((device) => device.revokedAt === null);
  expect(active).toHaveLength(1);
  expect(brain.app.pairing.revokeDevice(active[0]?.id ?? "")).toBe(true);

  await send(page, "Tu m'entends ?");
  await page.getByTestId("pairing-code").waitFor();
  await page.getByTestId("pairing-notice").filter({ hasText: "déconnecté" }).waitFor();
});

test("a window cannot answer a confirmation it was never asked; a malformed answer is refused", async () => {
  const brain = await startBrain();
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  const unknown = { type: "confirm", confirmationId: "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6", approved: true } as const;
  expect(await page.evaluate((answer) => window.alicia.brain.confirm(answer), unknown)).toBe(false);
  await expect(
    page.evaluate((answer) => window.alicia.brain.confirm(answer), { ...unknown, confirmationId: "pas-un-uuid" }),
  ).rejects.toThrow();
});

test("a confirmation card in the chat: Non keeps the memory, Oui forgets it", async () => {
  const { brain, memoryId } = await startForgettingBrain();
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);

  await send(page, "Oublie que je cours");
  const first = page.getByTestId("confirm-card").filter({ hasText: RUNNING }).first();
  await expect.poll(() => first.getAttribute("data-status"), POLL).toBe("pending");
  // While the card waits, no typing dots: the card is what Alicia waits for.
  expect(await page.getByRole("status", { name: "Alicia réfléchit" }).count()).toBe(0);
  await first.getByTestId("confirm-no").click();
  // The pressed button turns off: the cursor goes back to the message field.
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid")), POLL).toBe("composer-input");
  await page.getByTestId("message-assistant").filter({ hasText: "Je le garde." }).waitFor();
  await expect.poll(() => first.getAttribute("data-status"), POLL).toBe("refused");
  await first.getByTestId("confirm-outcome").filter({ hasText: "Alicia ne l'a pas fait" }).waitFor();
  expect(brain.app.memory.get("kevin", memoryId)).toBeDefined();

  await send(page, "Si, oublie-le");
  const second = page.getByTestId("confirm-card").nth(1);
  await expect.poll(() => second.getAttribute("data-status"), POLL).toBe("pending");
  await second.getByTestId("confirm-yes").click();
  await page.getByTestId("message-assistant").filter({ hasText: "C'est oublié." }).waitFor();
  await expect.poll(() => second.getAttribute("data-status"), POLL).toBe("approved");
  expect(brain.app.memory.get("kevin", memoryId)).toBeUndefined();
});

/** Alicia remembers « Kévin adore les lasagnes » when asked to, like the model would with its tool. */
const REMEMBERS_LASAGNES: Scenario = async (request) => {
  if (request.prompt.includes("lasagnes")) {
    await callTool(request, "memory_remember", { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" });
  }
  return [
    { type: "session", sessionId: "s1" },
    { type: "text", text: "C'est noté !" },
    { type: "done", inputTokens: 1, outputTokens: 1 },
  ];
};

const ASKED = "Retiens que j'adore les lasagnes";

/** Opens the Souvenirs screen and waits for its list. */
async function openMemories(page: Page): Promise<void> {
  await page.getByTestId("nav-memories").click();
  await page.getByTestId("memory-view").waitFor();
  await expect.poll(() => page.getByTestId("titlebar-title").textContent(), POLL).toBe("Souvenirs");
}

test("Souvenirs: a memory Alicia kept is corrected, pinned, forgotten, restored, and found by the test bench", async () => {
  const brain = await startBrain(REMEMBERS_LASAGNES);
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  await send(page, ASKED);
  await answered(page, 1);

  await openMemories(page);
  const card = page.getByTestId("memory-card").filter({ hasText: "lasagnes" });
  await card.click();
  await expect
    .poll(() => page.getByTestId("memory-provenance").textContent(), POLL)
    .toContain(`Retenu par Alicia pendant “${ASKED}”`);

  // Correct the text.
  await expect.poll(() => page.getByTestId("memory-save").isDisabled(), POLL).toBe(true);
  await page.getByTestId("memory-text").fill("Kévin adore les lasagnes de mamie");
  await page.getByTestId("memory-save").click();
  await card.filter({ hasText: "Kévin adore les lasagnes de mamie" }).waitFor();
  await expect.poll(() => page.getByTestId("memory-save").isDisabled(), POLL).toBe(true);

  // Pin it.
  await page.getByTestId("memory-pin").click();
  await page.getByTestId("memory-save").click();
  await card.filter({ has: page.getByRole("img", { name: "Épinglé" }) }).waitFor();
  expect(brain.app.memory.list("kevin", {}).map((m) => [m.text, m.pinned])).toEqual([["Kévin adore les lasagnes de mamie", true]]);

  // Test bench: what Alicia would find, and why (before forgetting it).
  await page.getByTestId("memory-search").fill("lasagnes");
  await page.getByTestId("memory-bench-run").click();
  const firstHit = page.getByTestId("memory-bench-hit").first();
  await firstHit.filter({ hasText: "Kévin adore les lasagnes de mamie" }).waitFor();
  await expect.poll(() => firstHit.getByTestId("memory-bench-reasons").textContent(), POLL).toContain("mots en commun");
  // The bench does not count as a recall.
  expect(brain.app.memory.list("kevin", {})[0]?.recallCount).toBe(0);
  await page.getByTestId("memory-bench-close").click();
  await page.getByTestId("memory-bench").waitFor({ state: "detached" });
  await page.getByTestId("memory-search").fill("");

  // Forget it, find it in the trash, restore it.
  await page.getByTestId("memory-forget").click();
  await page.getByTestId("memory-forget-yes").click();
  await expect.poll(() => page.getByTestId("memory-card").count(), POLL).toBe(0);
  await page.getByTestId("memory-tab-trash").click();
  await page.getByTestId("memory-card").filter({ hasText: "oublié le" }).waitFor();
  await page.getByTestId("memory-restore").click();
  await page.getByTestId("memory-empty").filter({ hasText: "La corbeille est vide." }).waitFor();
  await page.getByTestId("memory-tab-all").click();
  await card.filter({ hasText: "Kévin adore les lasagnes de mamie" }).waitFor();
});

test("Souvenirs: a memory added by hand, then a conversation deleted from the menu keeps its memories", async () => {
  const brain = await startBrain(REMEMBERS_LASAGNES);
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  await send(page, ASKED);
  await answered(page, 1);

  // Added by hand, for the whole family.
  await openMemories(page);
  await page.getByTestId("memory-new").click();
  await page.getByTestId("memory-text").fill("Le chat s'appelle Moka");
  await page.getByTestId("memory-scope-common").click();
  await page.getByTestId("memory-save").click();
  await expect.poll(() => page.getByTestId("memory-provenance").textContent(), POLL).toContain("Ajouté à la main");
  await page.getByTestId("memory-tab-common").click();
  await page.getByTestId("memory-card").filter({ hasText: "Le chat s'appelle Moka" }).waitFor();
  await expect.poll(() => page.getByTestId("memory-card").count(), POLL).toBe(1);

  // Delete the conversation from the menu (back in the chat, where it is open).
  await page.getByTestId("conversation-list").getByRole("button", { name: ASKED, exact: true }).click();
  await page.getByTestId("message-user").filter({ hasText: ASKED }).waitFor();
  const row = page.getByTestId("conversation-list").locator("li").filter({ hasText: ASKED });
  const trash = row.getByTestId("delete-conversation");
  // The trash button fades in on hover; activated from the keyboard, so a slow paint of the hover cannot misplace a click.
  await trash.press("Enter");
  await page.getByTestId("delete-conversation-yes").click();
  await page.getByTestId("chat-welcome").waitFor();
  await expect.poll(() => row.count(), POLL).toBe(0);
  await expect.poll(() => page.getByTestId("titlebar-title").textContent(), POLL).toBe("Nouvelle conversation");

  // The memory stays, its origin now a deleted conversation.
  await openMemories(page);
  // The screen kept its tab (Famille): the memory is personal.
  await page.getByTestId("memory-tab-all").click();
  await page.getByTestId("memory-card").filter({ hasText: "lasagnes" }).click();
  await expect
    .poll(() => page.getByTestId("memory-provenance").textContent(), POLL)
    .toContain("Retenu pendant une conversation supprimée");
});

test("attachments: refused before sending when unsupported; a PDF is uploaded, sent and described to Alicia", async () => {
  let seenPrompt = "";
  let seenDirs: readonly string[] = [];
  const brain = await startBrain((request) => {
    seenPrompt = request.prompt;
    seenDirs = request.readableDirs;
    return [
      { type: "session", sessionId: "s1" },
      { type: "text", text: "Facture de 42 €." },
      { type: "done", inputTokens: 1, outputTokens: 1 },
    ];
  });
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  const files = tempDir("alicia-e2e-files-");
  const pdf = join(files, "facture.pdf");
  writeFileSync(pdf, "%PDF-1.7\n1 0 obj\n");
  const exe = join(files, "outil.exe");
  writeFileSync(exe, "MZ");

  // Refused in the app, before anything reaches the brain.
  await page.getByTestId("composer-file").setInputFiles(exe);
  await page.getByTestId("notice").filter({ hasText: "« outil.exe » n'est pas pris en charge" }).waitFor();
  expect(await page.getByTestId("attachment-chip").count()).toBe(0);

  await page.getByTestId("composer-file").setInputFiles(pdf);
  const chip = page.getByTestId("attachment-chip").filter({ hasText: "facture.pdf" });
  await expect.poll(() => chip.getAttribute("data-status"), POLL).toBe("ready");
  await send(page, "Combien ?");
  await page.getByTestId("message-assistant").filter({ hasText: "Facture de 42 €." }).waitFor();
  await page.getByTestId("message-attachment").filter({ hasText: "facture.pdf" }).waitFor();
  await expect.poll(() => page.getByTestId("attachment-chip").count(), POLL).toBe(0);
  expect(seenPrompt).toContain('"facture.pdf" (PDF');
  expect(seenDirs).toHaveLength(1);
});

test("attachments: a file dropped on the window becomes a chip, and can be removed", async () => {
  const brain = await startBrain();
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["Liste : pain, œufs"], "courses.txt", { type: "text/plain" }));
    const target = document.querySelector("[data-testid=composer]");
    for (const type of ["dragenter", "dragover", "drop"]) {
      target?.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  });
  const chip = page.getByTestId("attachment-chip").filter({ hasText: "courses.txt" });
  await expect.poll(() => chip.getAttribute("data-status"), POLL).toBe("ready");
  await chip.getByTestId("attachment-remove").click();
  await expect.poll(() => page.getByTestId("attachment-chip").count(), POLL).toBe(0);
  // No chip left: the focus goes back to the message field.
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid")), POLL).toBe("composer-input");
  // The brain forgot the upload too.
  const pendingDir = join(dirname(brain.app.attachments.dirOf("11111111-1111-4111-8111-111111111111")), "pending");
  await expect.poll(() => readdirSync(pendingDir), POLL).toEqual([]);
});

test("attachments: a pasted picture becomes a chip; text copied from Office (text and picture) stays text", async () => {
  const brain = await startBrain();
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  /** Pastes into the message field; true when the app took the paste over (default prevented). */
  const paste = (withText: boolean): Promise<boolean> => page.evaluate((text) => {
    const data = new DataTransfer();
    if (text) data.setData("text/plain", "Total : 420 €");
    data.items.add(new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])], "image.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector("[data-testid=composer-input]")?.dispatchEvent(event);
    return event.defaultPrevented;
  }, withText);
  expect(await paste(true)).toBe(false);
  expect(await page.getByTestId("attachment-chip").count()).toBe(0);
  expect(await paste(false)).toBe(true);
  const chip = page.getByTestId("attachment-chip").filter({ hasText: "image.png" });
  await expect.poll(() => chip.getAttribute("data-status"), POLL).toBe("ready");
});

test("Comptes: says when Google is not configured on the brain", async () => {
  const brain = await startBrain();
  const { page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  await page.getByTestId("nav-accounts").click();
  await page.getByTestId("accounts-unavailable").waitFor();
  expect(await page.getByTestId("accounts-add-common").count()).toBe(0);
  expect(await page.getByTestId("nav-accounts-attention").count()).toBe(0);
});

test("Comptes: a Famille account connected through the browser, a flow cancelled, then the account removed", async () => {
  const google = new FakeGoogle();
  const brain = await startGoogleBrain(google);
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);

  await page.getByTestId("nav-accounts").click();
  await page.getByTestId("accounts-add-common").waitFor();
  expect(await page.getByTestId("account-row").count()).toBe(0);

  // Google's page opens in the browser (recorded, never opened, here); the person says yes there.
  await page.getByTestId("accounts-add-common").click();
  await page.getByTestId("accounts-waiting").waitFor();
  await playGoogleConsent(app, google, "famille@example.com", 0);
  const row = page.getByTestId("accounts-section-common").getByTestId("account-row").filter({ hasText: "famille@example.com" });
  await row.filter({ hasText: "Connecté" }).waitFor();
  await page.getByTestId("accounts-message").filter({ hasText: "famille@example.com est connecté." }).waitFor();
  await page.getByTestId("accounts-waiting").waitFor({ state: "detached" });
  expect(await page.getByTestId("accounts-section-personal").getByTestId("account-row").count()).toBe(0);

  // Changed her mind before answering Google: Annuler, and nothing is said.
  await page.getByTestId("accounts-add-personal").click();
  await page.getByTestId("accounts-cancel").click();
  await page.getByTestId("accounts-waiting").waitFor({ state: "detached" });
  expect(await page.getByTestId("accounts-message").count()).toBe(0);

  // Removing asks first, the safe answer focused; « Non » or Escape gives the focus back to the trash. Then Alicia's
  // access is revoked at Google, and the focus goes to « Ajouter… » (the row is gone).
  const focused = (): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
  await row.getByTestId("account-remove").click();
  await expect.poll(focused, POLL).toBe("account-remove-no");
  await row.getByTestId("account-remove-no").click();
  await expect.poll(focused, POLL).toBe("account-remove");
  await row.getByTestId("account-remove").click();
  await expect.poll(focused, POLL).toBe("account-remove-no");
  await page.keyboard.press("Escape");
  await expect.poll(focused, POLL).toBe("account-remove");
  expect(await row.getByTestId("account-remove-yes").count()).toBe(0);
  await row.getByTestId("account-remove").click();
  await row.getByTestId("account-remove-yes").click();
  await expect.poll(() => page.getByTestId("account-row").count(), POLL).toBe(0);
  await expect.poll(focused, POLL).toBe("accounts-add-common");
  await page.getByTestId("accounts-message").filter({ hasText: "Compte retiré." }).waitFor();
  expect(google.revoked).toHaveLength(1);
  expect((await recorded(app)).browser).toHaveLength(2);
  // Nothing was ever sent.
  expect(google.requests.some((request) => request.url.pathname.endsWith("/send"))).toBe(false);
  expect(google.refusedRoutes).toEqual([]);
});

test("chat: an account Google stopped accepting gets a « Reconnecter le compte » card, fixed from Comptes in one click", async () => {
  const google = new FakeGoogle();
  google.addCalendar("famille@example.com", {
    id: "famille@example.com", summary: "Famille", accessRole: "owner", primary: true, selected: true,
  });
  const brain = await startGoogleBrain(google, async (request) => {
    await callTool(request, "calendar_list", { from: "2026-10-10", to: "2026-10-10" });
    return [
      { type: "session", sessionId: "s1" },
      { type: "text", text: "Je n'arrive plus à lire l'agenda Famille." },
      { type: "done", inputTokens: 1, outputTokens: 1 },
    ];
  });
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);

  await page.getByTestId("nav-accounts").click();
  await page.getByTestId("accounts-add-common").click();
  await playGoogleConsent(app, google, "famille@example.com", 0);
  const row = page.getByTestId("account-row").filter({ hasText: "famille@example.com" });
  await row.filter({ hasText: "Connecté" }).waitFor();
  expect(await page.getByTestId("nav-accounts-attention").count()).toBe(0);

  // Kévin removed Alicia from the Google account: the next use asks, right in the chat, to reconnect.
  google.revokeGrant("famille@example.com");
  google.expireAccessTokens();
  await page.getByTestId("nav-chat").click();
  await send(page, "On a quoi samedi ?");
  await answered(page, 1);
  const card = page.getByTestId("reconnect-card").filter({ hasText: "famille@example.com" });
  await card.waitFor();
  await page.getByTestId("nav-accounts-attention").waitFor();

  // One click: Comptes opens, Google's page opens in the browser (recorded here), and the account is back.
  await card.getByTestId("reconnect-card-button").click();
  await page.getByTestId("accounts-view").waitFor();
  await page.getByTestId("accounts-waiting").waitFor();
  await expect.poll(async () => (await recorded(app)).browser.length, POLL).toBe(2);
  const consent = new URL((await recorded(app)).browser[1] ?? "");
  // The same address is suggested to Google.
  expect(consent.searchParams.get("login_hint")).toBe("famille@example.com");
  await playGoogleConsent(app, google, "famille@example.com", 1);
  await row.filter({ hasText: "Connecté" }).waitFor();
  await expect.poll(() => page.getByTestId("nav-accounts-attention").count(), POLL).toBe(0);
  await page.getByTestId("nav-chat").click();
  await expect.poll(() => page.getByTestId("reconnect-card").count(), POLL).toBe(0);

  // Reconnected, not added twice; and nothing was ever sent.
  await page.getByTestId("nav-accounts").click();
  await expect.poll(() => page.getByTestId("account-row").count(), POLL).toBe(1);
  expect(google.requests.some((r) => r.url.pathname.endsWith("/send"))).toBe(false);
  expect(google.refusedRoutes).toEqual([]);
});

test("Holo and Spotlight: an account to reconnect gets its card there too, and the main window knows at once", async () => {
  const google = new FakeGoogle();
  google.addCalendar("famille@example.com", {
    id: "famille@example.com", summary: "Famille", accessRole: "owner", primary: true, selected: true,
  });
  const brain = await startGoogleBrain(google, async (request) => {
    await callTool(request, "calendar_list", { from: "2026-10-10", to: "2026-10-10" });
    return [
      { type: "session", sessionId: "s1" },
      { type: "text", text: "Je n'arrive plus à lire l'agenda Famille." },
      { type: "done", inputTokens: 1, outputTokens: 1 },
    ];
  });
  const { app, page } = await launch(tempDir("alicia-e2e-profile-"));
  await pair(page, brain);
  await page.getByTestId("nav-accounts").click();
  await page.getByTestId("accounts-add-common").click();
  await playGoogleConsent(app, google, "famille@example.com", 0);
  const row = page.getByTestId("account-row").filter({ hasText: "famille@example.com" });
  await row.filter({ hasText: "Connecté" }).waitFor();
  await page.getByTestId("nav-chat").click();

  // A question in the Holo's mini-chat, after Kévin removed Alicia from the Google account.
  google.revokeGrant("famille@example.com");
  google.expireAccessTokens();
  const holo = await surfacePage(app, "holo");
  await expect.poll(() => windowVisible(app, "holo"), POLL).toBe(true);
  await holo.getByTestId("holo-mascot").click();
  await holo.getByTestId("holo-chat").waitFor();
  await expect.poll(() => holo.getByTestId("holo-input").isEnabled(), POLL).toBe(true);
  await holo.getByTestId("holo-input").fill("On a quoi samedi ?");
  await holo.getByTestId("holo-input").press("Enter");
  const holoCard = holo.getByTestId("holo-reconnect-card").filter({ hasText: "famille@example.com" });
  await holoCard.waitFor();
  // The main window knows too: the menu's dot, and a banner (the Holo's conversation is not the one shown).
  await page.getByTestId("nav-accounts-attention").waitFor();
  await page.getByTestId("reconnect-banner").filter({ hasText: "Un compte Google doit être reconnecté" }).waitFor();
  expect(await page.getByTestId("reconnect-card").count()).toBe(0);

  // One click in the Holo: the main window opens on Comptes and Google's page opens in the browser (recorded here).
  await holoCard.getByTestId("holo-reconnect-button").click();
  await expect.poll(() => holo.getByTestId("holo-reconnect-card").count(), POLL).toBe(0);
  await page.getByTestId("accounts-view").waitFor();
  await page.getByTestId("accounts-waiting").waitFor();
  await expect.poll(async () => (await recorded(app)).browser.length, POLL).toBe(2);
  expect(new URL((await recorded(app)).browser[1] ?? "").searchParams.get("login_hint")).toBe("famille@example.com");
  await playGoogleConsent(app, google, "famille@example.com", 1);
  await row.filter({ hasText: "Connecté" }).waitFor();
  await expect.poll(() => page.getByTestId("nav-accounts-attention").count(), POLL).toBe(0);
  await page.getByTestId("nav-chat").click();
  await expect.poll(() => page.getByTestId("reconnect-banner").count(), POLL).toBe(0);

  // The same from the Spotlight bar, which closes once it asked: the main window keeps the card.
  google.revokeGrant("famille@example.com");
  google.expireAccessTokens();
  await callHook(app, "triggerShortcut");
  const bar = await surfacePage(app, "spotlight");
  await expect.poll(() => windowVisible(app, "spotlight"), POLL).toBe(true);
  await bar.getByTestId("spotlight-input").fill("Et dimanche ?");
  await bar.getByTestId("spotlight-input").press("Enter");
  const banner = page.getByTestId("reconnect-banner");
  await banner.waitFor();
  await page.getByTestId("nav-accounts-attention").waitFor();
  // « Ouvrir Comptes » leads to the account's row; back in the chat, its conversation shows the card itself.
  await banner.getByTestId("reconnect-banner-open").click();
  await page.getByTestId("accounts-view").waitFor();
  await row.filter({ hasText: "À reconnecter" }).waitFor();
  await expect.poll(() => banner.count(), POLL).toBe(0);
  await page.getByTestId("nav-chat").click();
  await banner.waitFor();
  await page.getByTestId("conversation-list").getByText("Et dimanche ?").click();
  await page.getByTestId("reconnect-card").filter({ hasText: "famille@example.com" }).waitFor();
  await expect.poll(() => banner.count(), POLL).toBe(0);
  expect(google.requests.some((r) => r.url.pathname.endsWith("/send"))).toBe(false);
  expect(google.refusedRoutes).toEqual([]);
});
