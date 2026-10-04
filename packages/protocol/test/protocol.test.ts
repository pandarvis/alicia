import { describe, expect, test } from "vitest";
import {
  ClientMessage,
  ConversationSummary,
  PairingRequest,
  Person,
  PersonId,
  ServerEvent,
} from "../src/index.ts";

const UUID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

describe("identity", () => {
  test("accepts a valid person", () => {
    expect(Person.parse({ id: "kevin", nom: "Kévin" })).toEqual({ id: "kevin", nom: "Kévin" });
  });
  test("rejects an id with uppercase letters or accents", () => {
    expect(Person.safeParse({ id: "Élodie", nom: "Élodie" }).success).toBe(false);
  });
  test("rejects an id that is too short", () => {
    expect(PersonId.safeParse("a").success).toBe(false);
  });
  test("rejects an id with an underscore", () => {
    expect(PersonId.safeParse("kevin_").success).toBe(false);
  });
});

describe("client messages", () => {
  test("accepts a minimal send", () => {
    const m = ClientMessage.parse({ type: "envoyer", idRequete: UUID, texte: "Bonjour" });
    expect(m.type).toBe("envoyer");
  });
  test("accepts a full send", () => {
    const m = ClientMessage.parse({
      type: "envoyer", idRequete: UUID, conversationId: UUID, texte: "Salut", modele: "opus",
    });
    expect(m).toMatchObject({ conversationId: UUID, modele: "opus" });
  });
  test("rejects an empty text (whitespace only)", () => {
    expect(ClientMessage.safeParse({ type: "envoyer", idRequete: UUID, texte: "   " }).success).toBe(false);
  });
  test("keeps the text's leading whitespace", () => {
    const m = ClientMessage.parse({ type: "envoyer", idRequete: UUID, texte: "  Bonjour" });
    expect(m).toMatchObject({ texte: "  Bonjour" });
  });
  test("accepts 20,000 characters and rejects 20,001", () => {
    expect(
      ClientMessage.safeParse({ type: "envoyer", idRequete: UUID, texte: "a".repeat(20_000) }).success,
    ).toBe(true);
    expect(
      ClientMessage.safeParse({ type: "envoyer", idRequete: UUID, texte: "a".repeat(20_001) }).success,
    ).toBe(false);
  });
  test("rejects an unknown model", () => {
    expect(
      ClientMessage.safeParse({ type: "envoyer", idRequete: UUID, texte: "x", modele: "gpt" }).success,
    ).toBe(false);
  });
  test("rejects an unknown key in a send", () => {
    expect(
      ClientMessage.safeParse({ type: "envoyer", idRequete: UUID, texte: "x", admin: true }).success,
    ).toBe(false);
  });
  test("accepts authentication", () => {
    expect(ClientMessage.parse({ type: "authentifier", jeton: "a".repeat(43) }).type).toBe("authentifier");
  });
  test("rejects a 19-character token", () => {
    expect(ClientMessage.safeParse({ type: "authentifier", jeton: "a".repeat(19) }).success).toBe(false);
  });
  test("rejects an unknown key in authentication", () => {
    expect(
      ClientMessage.safeParse({ type: "authentifier", jeton: "a".repeat(43), admin: true }).success,
    ).toBe(false);
  });
  test("rejects an unknown type", () => {
    expect(ClientMessage.safeParse({ type: "pirater" }).success).toBe(false);
  });
});

describe("server events", () => {
  const events: unknown[] = [
    { type: "pret", personne: { id: "kevin", nom: "Kévin" } },
    { type: "conversation", idRequete: UUID, conversationId: UUID },
    { type: "morceau_texte", conversationId: UUID, texte: "Bon" },
    { type: "appel_outil", conversationId: UUID, idAppel: "t1", outil: "meteo" },
    { type: "resultat_outil", conversationId: UUID, idAppel: "t1", succes: true },
    { type: "fin", conversationId: UUID, modele: "sonnet", tokensEntree: 10, tokensSortie: 5, dureeMs: 900 },
    { type: "erreur", code: "quota", message: "Je me repose." },
  ];
  test.each(events)("accepts the event %j", (e) => {
    expect(ServerEvent.safeParse(e).success).toBe(true);
  });
  test("rejects negative tokens", () => {
    expect(
      ServerEvent.safeParse({
        type: "fin", conversationId: UUID, modele: "sonnet", tokensEntree: -1, tokensSortie: 0, dureeMs: 0,
      }).success,
    ).toBe(false);
  });
  test("rejects non-integer tokens", () => {
    expect(
      ServerEvent.safeParse({
        type: "fin", conversationId: UUID, modele: "sonnet", tokensEntree: 1.5, tokensSortie: 0, dureeMs: 0,
      }).success,
    ).toBe(false);
  });
  test("accepts the busy error code", () => {
    expect(ServerEvent.safeParse({ type: "erreur", code: "occupe", message: "x" }).success).toBe(true);
  });
  test("rejects an unknown error code", () => {
    expect(ServerEvent.safeParse({ type: "erreur", code: "bizarre", message: "x" }).success).toBe(false);
  });
});

describe("HTTP", () => {
  test("the pairing code is exactly 6 digits", () => {
    expect(PairingRequest.safeParse({ code: "123456", nomAppareil: "PC Kévin" }).success).toBe(true);
    expect(PairingRequest.safeParse({ code: "12345", nomAppareil: "PC" }).success).toBe(false);
    expect(PairingRequest.safeParse({ code: "12345a", nomAppareil: "PC" }).success).toBe(false);
  });
  test("rejects an unknown key in the pairing request", () => {
    expect(
      PairingRequest.safeParse({ code: "123456", nomAppareil: "PC", admin: true }).success,
    ).toBe(false);
  });
  test("rejects a non-ISO date in a conversation summary", () => {
    expect(ConversationSummary.safeParse({ id: UUID, titre: "t", majLe: "hier" }).success).toBe(false);
    expect(
      ConversationSummary.safeParse({ id: UUID, titre: "t", majLe: "2026-10-04T12:00:00Z" }).success,
    ).toBe(true);
  });
});
