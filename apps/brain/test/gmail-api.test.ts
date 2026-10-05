import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { GmailApi } from "../src/google/gmail-api.ts";
import { GoogleApiError } from "../src/google/http.ts";
import { createFamilyGoogle } from "./google-fixture.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Every TypeScript file of the brain, except the fake Google (which refuses sending URLs, so names them). */
function brainSources(dir = SRC): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return brainSources(path);
    if (!entry.name.endsWith(".ts") || entry.name === "fake-google.ts") return [];
    return [{ path, text: readFileSync(path, "utf8") }];
  });
}

describe("Gmail API", () => {
  test("search gives summaries, read gives the text", async () => {
    const { kevinAccess, accounts } = await createFamilyGoogle();
    const gmail = new GmailApi(kevinAccess);
    const found = await gmail.search(accounts.famille, "is:unread sortie", 10);
    expect(found).toEqual([expect.objectContaining({
      id: "famillemail1", from: "École <ecole@example.com>", subject: "Sortie scolaire", unread: true,
    })]);
    const mail = await gmail.read(accounts.famille, "famillemail1");
    expect(mail.text).toBe("Autorisation à signer avant vendredi.");
    expect(mail.messageId).toBe("<sortie@ecole.example.com>");
  });

  test("no code path can send a mail: no sending URL anywhere in the brain, no sending method", () => {
    const sources = brainSources();
    expect(sources.length).toBeGreaterThan(20);
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/\/send\b|messages\.send|drafts\.send|gmail\.send|mail\.google\.com/u);
    }
    const methods = Object.getOwnPropertyNames(GmailApi.prototype);
    expect(methods.filter((name) => /send|forward|reply|trash|delete|modify/iu.test(name))).toEqual([]);
  });

  test("a search reads at most 25 mails, whatever is asked", async () => {
    const { kevinAccess, accounts, google } = await createFamilyGoogle();
    const gmail = new GmailApi(kevinAccess);
    await gmail.search(accounts.famille, "sortie", 1000);
    await gmail.search(accounts.famille, "sortie", -3);
    const lists = google.requests.filter((r) => r.url.pathname.endsWith("/messages"));
    expect(lists.map((r) => r.url.searchParams.get("maxResults"))).toEqual(["25", "1"]);
  });

  test("message ids '..', '.' and '' are refused before any call", async () => {
    const { kevinAccess, accounts, google } = await createFamilyGoogle();
    const gmail = new GmailApi(kevinAccess);
    const before = google.requests.length;
    for (const id of ["..", ".", ""]) {
      const failure = await gmail.read(accounts.famille, id)
        .then(() => "none", (error: unknown) => (error instanceof GoogleApiError ? error.failure : "other"));
      expect(failure, id).toBe("invalid");
    }
    expect(google.requests.length).toBe(before);
  });

  test("a draft is created, never sent", async () => {
    const { kevinAccess, accounts, google } = await createFamilyGoogle();
    const gmail = new GmailApi(kevinAccess);
    const id = await gmail.createDraft(accounts.famille, "cmF3", "famillemail1");
    expect(id).toMatch(/^draft-/);
    expect(google.drafts("famille@example.com")).toEqual([{ id, raw: "cmF3", threadId: "famillemail1" }]);
    expect(google.requests.some((r) => r.url.pathname.endsWith("/send"))).toBe(false);
  });
});
