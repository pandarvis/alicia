import { describe, expect, test } from "vitest";
import {
  EvenementServeur,
  IdPersonne,
  MessageClient,
  Personne,
  RequeteAppairage,
  ResumeConversation,
} from "../src/index.ts";

const UUID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

describe("identité", () => {
  test("accepte une personne valide", () => {
    expect(Personne.parse({ id: "kevin", nom: "Kévin" })).toEqual({ id: "kevin", nom: "Kévin" });
  });
  test("refuse un identifiant avec majuscules ou accents", () => {
    expect(Personne.safeParse({ id: "Élodie", nom: "Élodie" }).success).toBe(false);
  });
  test("refuse un identifiant trop court", () => {
    expect(IdPersonne.safeParse("a").success).toBe(false);
  });
  test("refuse un identifiant avec underscore", () => {
    expect(IdPersonne.safeParse("kevin_").success).toBe(false);
  });
});

describe("messages client", () => {
  test("accepte un envoi minimal", () => {
    const m = MessageClient.parse({ type: "envoyer", idRequete: UUID, texte: "Bonjour" });
    expect(m.type).toBe("envoyer");
  });
  test("accepte un envoi complet", () => {
    const m = MessageClient.parse({
      type: "envoyer", idRequete: UUID, conversationId: UUID, texte: "Salut", modele: "opus",
    });
    expect(m).toMatchObject({ conversationId: UUID, modele: "opus" });
  });
  test("refuse un texte vide (espaces seulement)", () => {
    expect(MessageClient.safeParse({ type: "envoyer", idRequete: UUID, texte: "   " }).success).toBe(false);
  });
  test("conserve les espaces de tête du texte", () => {
    const m = MessageClient.parse({ type: "envoyer", idRequete: UUID, texte: "  Bonjour" });
    expect(m).toMatchObject({ texte: "  Bonjour" });
  });
  test("accepte 20 000 caractères et refuse 20 001", () => {
    expect(
      MessageClient.safeParse({ type: "envoyer", idRequete: UUID, texte: "a".repeat(20_000) }).success,
    ).toBe(true);
    expect(
      MessageClient.safeParse({ type: "envoyer", idRequete: UUID, texte: "a".repeat(20_001) }).success,
    ).toBe(false);
  });
  test("refuse un modèle inconnu", () => {
    expect(
      MessageClient.safeParse({ type: "envoyer", idRequete: UUID, texte: "x", modele: "gpt" }).success,
    ).toBe(false);
  });
  test("refuse une clé inconnue dans un envoi", () => {
    expect(
      MessageClient.safeParse({ type: "envoyer", idRequete: UUID, texte: "x", admin: true }).success,
    ).toBe(false);
  });
  test("accepte l'authentification", () => {
    expect(MessageClient.parse({ type: "authentifier", jeton: "a".repeat(43) }).type).toBe("authentifier");
  });
  test("refuse un jeton de 19 caractères", () => {
    expect(MessageClient.safeParse({ type: "authentifier", jeton: "a".repeat(19) }).success).toBe(false);
  });
  test("refuse une clé inconnue dans l'authentification", () => {
    expect(
      MessageClient.safeParse({ type: "authentifier", jeton: "a".repeat(43), admin: true }).success,
    ).toBe(false);
  });
  test("refuse un type inconnu", () => {
    expect(MessageClient.safeParse({ type: "pirater" }).success).toBe(false);
  });
});

describe("événements serveur", () => {
  const evenements: unknown[] = [
    { type: "pret", personne: { id: "kevin", nom: "Kévin" } },
    { type: "conversation", idRequete: UUID, conversationId: UUID },
    { type: "morceau_texte", conversationId: UUID, texte: "Bon" },
    { type: "appel_outil", conversationId: UUID, idAppel: "t1", outil: "meteo" },
    { type: "resultat_outil", conversationId: UUID, idAppel: "t1", succes: true },
    { type: "fin", conversationId: UUID, modele: "sonnet", tokensEntree: 10, tokensSortie: 5, dureeMs: 900 },
    { type: "erreur", code: "quota", message: "Je me repose." },
  ];
  test.each(evenements)("accepte l'événement %j", (e) => {
    expect(EvenementServeur.safeParse(e).success).toBe(true);
  });
  test("refuse des tokens négatifs", () => {
    expect(
      EvenementServeur.safeParse({
        type: "fin", conversationId: UUID, modele: "sonnet", tokensEntree: -1, tokensSortie: 0, dureeMs: 0,
      }).success,
    ).toBe(false);
  });
  test("refuse des tokens non entiers", () => {
    expect(
      EvenementServeur.safeParse({
        type: "fin", conversationId: UUID, modele: "sonnet", tokensEntree: 1.5, tokensSortie: 0, dureeMs: 0,
      }).success,
    ).toBe(false);
  });
  test("refuse un code d'erreur inconnu", () => {
    expect(EvenementServeur.safeParse({ type: "erreur", code: "bizarre", message: "x" }).success).toBe(false);
  });
});

describe("HTTP", () => {
  test("le code d'appairage fait exactement 6 chiffres", () => {
    expect(RequeteAppairage.safeParse({ code: "123456", nomAppareil: "PC Kévin" }).success).toBe(true);
    expect(RequeteAppairage.safeParse({ code: "12345", nomAppareil: "PC" }).success).toBe(false);
    expect(RequeteAppairage.safeParse({ code: "12345a", nomAppareil: "PC" }).success).toBe(false);
  });
  test("refuse une clé inconnue dans la requête d'appairage", () => {
    expect(
      RequeteAppairage.safeParse({ code: "123456", nomAppareil: "PC", admin: true }).success,
    ).toBe(false);
  });
  test("refuse une date non ISO dans un résumé de conversation", () => {
    expect(ResumeConversation.safeParse({ id: UUID, titre: "t", majLe: "hier" }).success).toBe(false);
    expect(
      ResumeConversation.safeParse({ id: UUID, titre: "t", majLe: "2026-10-04T12:00:00Z" }).success,
    ).toBe(true);
  });
});
