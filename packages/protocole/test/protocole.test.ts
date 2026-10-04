import { describe, expect, test } from "vitest";
import {
  EvenementServeur,
  MessageClient,
  Personne,
  RequeteAppairage,
} from "../src/index.ts";

const UUID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

describe("identité", () => {
  test("accepte une personne valide", () => {
    expect(Personne.parse({ id: "kevin", nom: "Kévin" })).toEqual({ id: "kevin", nom: "Kévin" });
  });
  test("refuse un identifiant avec majuscules ou accents", () => {
    expect(Personne.safeParse({ id: "Élodie", nom: "Élodie" }).success).toBe(false);
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
  test("refuse un modèle inconnu", () => {
    expect(
      MessageClient.safeParse({ type: "envoyer", idRequete: UUID, texte: "x", modele: "gpt" }).success,
    ).toBe(false);
  });
  test("accepte l'authentification", () => {
    expect(MessageClient.parse({ type: "authentifier", jeton: "a".repeat(43) }).type).toBe("authentifier");
  });
  test("refuse un type inconnu", () => {
    expect(MessageClient.safeParse({ type: "pirater" }).success).toBe(false);
  });
});

describe("événements serveur", () => {
  test("accepte chaque type d'événement", () => {
    const evenements: unknown[] = [
      { type: "pret", personne: { id: "kevin", nom: "Kévin" } },
      { type: "conversation", idRequete: UUID, conversationId: UUID },
      { type: "morceau_texte", conversationId: UUID, texte: "Bon" },
      { type: "appel_outil", conversationId: UUID, idAppel: "t1", outil: "meteo" },
      { type: "resultat_outil", conversationId: UUID, idAppel: "t1", succes: true },
      { type: "fin", conversationId: UUID, modele: "sonnet", tokensEntree: 10, tokensSortie: 5, dureeMs: 900 },
      { type: "erreur", code: "quota", message: "Je me repose." },
    ];
    for (const e of evenements) expect(EvenementServeur.safeParse(e).success).toBe(true);
  });
  test("refuse des tokens négatifs", () => {
    expect(
      EvenementServeur.safeParse({
        type: "fin", conversationId: UUID, modele: "sonnet", tokensEntree: -1, tokensSortie: 0, dureeMs: 0,
      }).success,
    ).toBe(false);
  });
});

describe("HTTP", () => {
  test("le code d'appairage fait exactement 6 chiffres", () => {
    expect(RequeteAppairage.safeParse({ code: "123456", nomAppareil: "PC Kévin" }).success).toBe(true);
    expect(RequeteAppairage.safeParse({ code: "12345", nomAppareil: "PC" }).success).toBe(false);
    expect(RequeteAppairage.safeParse({ code: "12345a", nomAppareil: "PC" }).success).toBe(false);
  });
});
