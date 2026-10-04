import { describe, expect, test } from "vitest";
import { journal } from "../src/base/schema.ts";
import { DepotConversations } from "../src/conversations/depot.ts";
import { creerBaseTest, creerHorlogeTest } from "./aides.ts";

function creerDepot() {
  const base = creerBaseTest();
  const temps = creerHorlogeTest();
  return { base, temps, depot: new DepotConversations(base, temps.horloge) };
}

describe("DepotConversations", () => {
  test("crée puis retrouve une conversation de la bonne personne", () => {
    const { depot } = creerDepot();
    const c = depot.creer("kevin", "Volets");
    expect(c.sessionId).toBeNull();
    expect(depot.obtenir(c.id, "kevin")?.titre).toBe("Volets");
  });

  test("cloisonnement : Élodie ne voit pas la conversation de Kévin", () => {
    const { depot } = creerDepot();
    const c = depot.creer("kevin", "Privé");
    expect(depot.obtenir(c.id, "elodie")).toBeUndefined();
    expect(depot.lister("elodie")).toEqual([]);
  });

  test("liste de la plus récente à la plus ancienne (activité)", () => {
    const { depot, temps } = creerDepot();
    const a = depot.creer("kevin", "A");
    temps.avancer(1000);
    const b = depot.creer("kevin", "B");
    temps.avancer(1000);
    depot.ajouterMessage(a.id, "utilisateur", "relance");
    expect(depot.lister("kevin").map((c) => c.id)).toEqual([a.id, b.id]);
  });

  test("à égalité d'activité, la conversation créée en dernier passe en premier", () => {
    const { depot } = creerDepot();
    const a = depot.creer("kevin", "A");
    const b = depot.creer("kevin", "B");
    const c = depot.creer("kevin", "C");
    expect(depot.lister("kevin").map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });

  test("messages dans l'ordre, et derniers messages", () => {
    const { depot } = creerDepot();
    const c = depot.creer("kevin", "T");
    depot.ajouterMessage(c.id, "utilisateur", "1");
    depot.ajouterMessage(c.id, "alicia", "2");
    depot.ajouterMessage(c.id, "utilisateur", "3");
    expect(depot.messages(c.id).map((m) => m.texte)).toEqual(["1", "2", "3"]);
    expect(depot.derniersMessages(c.id, 2).map((m) => m.texte)).toEqual(["2", "3"]);
  });

  test("mémorise puis efface la session SDK", () => {
    const { depot } = creerDepot();
    const c = depot.creer("kevin", "T");
    depot.definirSession(c.id, "session-1");
    expect(depot.obtenir(c.id, "kevin")?.sessionId).toBe("session-1");
    depot.definirSession(c.id, null);
    expect(depot.obtenir(c.id, "kevin")?.sessionId).toBeNull();
  });

  test("journalise un tour avec ses outils en JSON", () => {
    const { base, depot } = creerDepot();
    const c = depot.creer("kevin", "T");
    depot.journaliser({
      conversationId: c.id, modele: "sonnet", tokensEntree: 12, tokensSortie: 3, dureeMs: 800,
      outils: [{ idAppel: "t1", outil: "meteo", succes: true }], erreur: null,
    });
    const ligne = base.select().from(journal).get();
    expect(ligne?.tokensEntree).toBe(12);
    expect(JSON.parse(ligne?.outils ?? "[]")).toEqual([{ idAppel: "t1", outil: "meteo", succes: true }]);
  });
});
