import type { Person } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import type { GoogleClient } from "../src/google/google-client.ts";
import { googleTools } from "../src/google/tools.ts";
import { ToolCatalog } from "../src/tools/catalog.ts";
import { createFamilyGoogle, runTool, TURN_CONV } from "./google-fixture.ts";
import { createTestTurn, ELODIE, KEVIN } from "./helpers.ts";

const KEVIN_SECRETS = /bague|Surprise anniversaire|kevinmail1|evtkevin1/;

/** The turn's tools exactly as Alicia gets them: catalog + 3a's guard (every confirmation answered yes). */
function turnTools(client: GoogleClient, person: Person) {
  const { turn, asked } = createTestTurn(person, TURN_CONV, "approved");
  return { tools: new ToolCatalog([googleTools(client, "Europe/Paris")]).forTurn(turn), asked };
}

/** Every way Élodie's turn could try to reach Kévin's personal account. */
const ATTEMPTS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["calendar_list", { from: "2026-10-01", to: "2026-10-30" }],
  ["calendar_create", { title: "x", start: "2026-10-12T10:00", account: "kevin@example.com", calendarId: "kevin@example.com" }],
  ["calendar_create", { title: "x", start: "2026-10-12T10:00", account: "KEVIN@example.com" }],
  ["calendar_create", { title: "x", start: "2026-10-12T10:00", calendarId: "kevin@example.com" }],
  ["calendar_update", { account: "kevin@example.com", calendarId: "kevin@example.com", eventId: "evtkevin1", title: "x" }],
  ["calendar_update", { account: "famille@example.com", calendarId: "kevin@example.com", eventId: "evtkevin1", title: "x" }],
  ["calendar_delete", { account: "kevin@example.com", calendarId: "kevin@example.com", eventId: "evtkevin1" }],
  ["calendar_delete", { account: "famille@example.com", calendarId: "famille@example.com", eventId: "evtkevin1" }],
  ["gmail_search", { query: "bague" }],
  ["gmail_search", { query: "bague", account: "kevin@example.com" }],
  ["gmail_search", { query: "bague", account: " Kevin@Example.com " }],
  ["gmail_read", { account: "kevin@example.com", messageId: "kevinmail1" }],
  ["gmail_read", { account: "famille@example.com", messageId: "kevinmail1" }],
  ["gmail_draft", { account: "kevin@example.com", to: ["a@example.com"], subject: "x", body: "x" }],
  ["gmail_draft", { account: "famille@example.com", to: ["a@example.com"], subject: "x", body: "x", replyToMessageId: "kevinmail1" }],
];

describe("cloisonnement of Google tools", () => {
  test("Élodie can never list, read or change Kévin's personal calendar or mail, whatever the parameters", async () => {
    const { client, google } = await createFamilyGoogle();
    const { tools, asked } = turnTools(client, ELODIE);
    const before = google.requests.length;
    for (const [name, args] of ATTEMPTS) {
      const result = await runTool(tools, name, args).catch((error: unknown) => ({ text: String(error) }));
      expect(result.text, `${name} ${JSON.stringify(args)}`).not.toMatch(KEVIN_SECRETS);
    }
    // Not a single call to Google with Kévin's token, no question naming his events.
    expect(google.requests.slice(before).filter((r) => r.email === "kevin@example.com")).toEqual([]);
    expect(asked.map((a) => a.summary).join("\n")).not.toMatch(KEVIN_SECRETS);
    expect(google.events("kevin@example.com", "kevin@example.com").map((e) => e["summary"])).toEqual(["Surprise anniversaire Élodie"]);
    expect(google.drafts("kevin@example.com")).toEqual([]);
    // Her turn cannot mark his account « à reconnecter » either.
    expect(client.endTurn(TURN_CONV)).toEqual([]);
    expect(client.list(KEVIN).find((a) => a.email === "kevin@example.com")?.status).toBe("connected");
  });

  test("and the other way round: Kévin never reaches Élodie's personal account", async () => {
    const { client, google } = await createFamilyGoogle();
    google.addMail("elodie@example.com", {
      id: "elodiemail1", from: "Fleuriste <f@example.com>", to: "elodie@example.com", subject: "Bouquet pour Kévin",
      date: "Fri, 9 Oct 2026 10:00:00 +0200", receivedAt: Date.UTC(2026, 9, 9, 8), text: "Livraison samedi.",
    });
    const { tools } = turnTools(client, KEVIN);
    const before = google.requests.length;
    for (const args of [{ query: "bouquet" }, { query: "bouquet", account: "elodie@example.com" }]) {
      expect((await runTool(tools, "gmail_search", args)).text).not.toMatch(/Bouquet|elodiemail1/);
    }
    expect((await runTool(tools, "gmail_read", { account: "elodie@example.com", messageId: "elodiemail1" })).text)
      .toMatch(/Compte introuvable/);
    expect(google.requests.slice(before).filter((r) => r.email === "elodie@example.com")).toEqual([]);
  });
});
