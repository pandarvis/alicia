import type { GoogleOwner, Person } from "@alicia/protocol";
import { FakeGoogle } from "../src/google/fake-google.ts";
import { type GoogleAccess, GoogleClient } from "../src/google/google-client.ts";
import { GoogleOAuth } from "../src/google/oauth.ts";
import { createTestClock, createTestDb, createTestGoogleAccounts, ELODIE, KEVIN } from "./helpers.ts";

export const VERIFIER = "v".repeat(43);
export const REDIRECT = "http://127.0.0.1:4000";

/** A brain-side Google client wired to an in-memory Google. */
export function createGoogleFixture() {
  const db = createTestDb();
  const time = createTestClock();
  const google = new FakeGoogle();
  const accounts = createTestGoogleAccounts(db, time.clock);
  const oauth = new GoogleOAuth({ clientId: google.clientId, clientSecret: google.clientSecret }, google.fetch, time.clock);
  const client = new GoogleClient({ accounts, oauth, fetch: google.fetch, clock: time.clock, clientId: google.clientId });

  /** Runs the whole connection (code issued by Google, exchanged by the brain) and returns the account. */
  async function connect(person: Person, owner: GoogleOwner, email: string) {
    const result = await client.connect(person, {
      owner, code: google.issueCode(email), codeVerifier: VERIFIER, redirectUri: REDIRECT,
    });
    if (!("account" in result)) throw new Error(`connect failed: ${result.status}`);
    return result.account;
  }

  return { db, time, google, accounts, client, connect };
}

/** Kévin: Famille + his own; Élodie: her own. Each with a calendar and a mail. */
export async function createFamilyGoogle() {
  const fixture = createGoogleFixture();
  const { google } = fixture;
  for (const [email, summary] of [
    ["famille@example.com", "Famille"], ["kevin@example.com", "Kévin"], ["elodie@example.com", "Élodie"],
  ] as const) {
    google.addCalendar(email, { id: email, summary, accessRole: "owner", primary: true, selected: true });
  }
  google.addEvent("famille@example.com", "famille@example.com", {
    id: "evtfamille1", summary: "Piscine", location: "Centre aquatique",
    start: { dateTime: "2026-10-10T14:00:00+02:00" }, end: { dateTime: "2026-10-10T15:30:00+02:00" },
  });
  google.addEvent("kevin@example.com", "kevin@example.com", {
    id: "evtkevin1", summary: "Surprise anniversaire Élodie",
    start: { dateTime: "2026-10-10T19:00:00+02:00" }, end: { dateTime: "2026-10-10T22:00:00+02:00" },
  });
  google.addMail("kevin@example.com", {
    id: "kevinmail1", from: "Bijouterie <shop@example.com>", to: "kevin@example.com", subject: "Votre bague est prête",
    date: "Fri, 9 Oct 2026 10:00:00 +0200", receivedAt: Date.UTC(2026, 9, 9, 8), text: "La bague gravée pour Élodie est prête.",
    unread: true,
  });
  google.addMail("famille@example.com", {
    id: "famillemail1", from: "École <ecole@example.com>", to: "famille@example.com", subject: "Sortie scolaire",
    date: "Thu, 8 Oct 2026 09:00:00 +0200", receivedAt: Date.UTC(2026, 9, 8, 7), text: "Autorisation à signer avant vendredi.",
    unread: true, messageId: "<sortie@ecole.example.com>",
  });
  const famille = await fixture.connect(KEVIN, "common", "famille@example.com");
  const kevin = await fixture.connect(KEVIN, "personal", "kevin@example.com");
  const elodie = await fixture.connect(ELODIE, "personal", "elodie@example.com");
  const kevinAccess: GoogleAccess = fixture.client.forPerson(KEVIN);
  const elodieAccess: GoogleAccess = fixture.client.forPerson(ELODIE);
  return { ...fixture, accounts: { famille, kevin, elodie }, store: fixture.accounts, kevinAccess, elodieAccess };
}
