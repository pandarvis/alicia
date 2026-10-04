import type { EvenementServeur, MessageEnvoyer, Personne } from "@alicia/protocole";
import { describe, expect, test } from "vitest";
import { DepotConversations } from "../src/conversations/depot.ts";
import { traiterEnvoi } from "../src/conversations/service-chat.ts";
import { FauxMoteur, type Scenario } from "../src/moteur/faux-moteur.ts";
import { creerBaseTest, creerHorlogeTest, ELODIE, KEVIN } from "./aides.ts";

const ID_REQUETE = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

const REPONSE_SIMPLE: Scenario = () => [
  { type: "session", sessionId: "s1" },
  { type: "texte", texte: "Il fait " },
  { type: "texte", texte: "19 °C." },
  { type: "fin", tokensEntree: 100, tokensSortie: 8 },
];

function creerContexte(...scenarios: Scenario[]) {
  const base = creerBaseTest();
  const temps = creerHorlogeTest();
  const depot = new DepotConversations(base, temps.horloge);
  const moteur = new FauxMoteur(...scenarios);
  return { depot, moteur, deps: { depot, moteur, horloge: temps.horloge, fuseau: "Europe/Paris" } };
}

async function envoyer(
  deps: Parameters<typeof traiterEnvoi>[0], personne: Personne, message: Omit<MessageEnvoyer, "type" | "idRequete">,
) {
  const sortie: EvenementServeur[] = [];
  const complet: MessageEnvoyer = { type: "envoyer", idRequete: ID_REQUETE, ...message };
  for await (const e of traiterEnvoi(deps, personne, complet, new AbortController().signal)) sortie.push(e);
  return sortie;
}

describe("traiterEnvoi", () => {
  test("nouvelle conversation : événements, historique, session et journal", async () => {
    const { deps, depot, moteur } = creerContexte(REPONSE_SIMPLE);
    const evenements = await envoyer(deps, KEVIN, { texte: "Quelle température ?" });

    const premier = evenements[0];
    if (premier?.type !== "conversation") throw new Error("conversation attendue en premier");
    const id = premier.conversationId;
    expect(evenements.slice(1)).toEqual([
      { type: "morceau_texte", conversationId: id, texte: "Il fait " },
      { type: "morceau_texte", conversationId: id, texte: "19 °C." },
      { type: "fin", conversationId: id, modele: "sonnet", tokensEntree: 100, tokensSortie: 8, dureeMs: 0 },
    ]);
    expect(depot.messages(id).map((m) => [m.role, m.texte])).toEqual([
      ["utilisateur", "Quelle température ?"],
      ["alicia", "Il fait 19 °C."],
    ]);
    expect(depot.obtenir(id, "kevin")?.sessionId).toBe("s1");
    expect(depot.obtenir(id, "kevin")?.titre).toBe("Quelle température ?");
    expect(moteur.requetes[0]?.prompt).toMatch(/^\[dimanche 4 octobre 2026.*\]\nQuelle température \?$/);
    expect(moteur.requetes[0]?.consigneSysteme).toContain("Tu parles avec Kévin.");
  });

  test("conversation existante : reprend la session SDK", async () => {
    const { deps, moteur } = creerContexte(REPONSE_SIMPLE);
    const premiers = await envoyer(deps, KEVIN, { texte: "Un" });
    const id = premiers[0]?.type === "conversation" ? premiers[0].conversationId : "";
    await envoyer(deps, KEVIN, { texte: "Deux", conversationId: id });
    expect(moteur.requetes[1]?.sessionId).toBe("s1");
  });

  test("cloisonnement : Élodie ne peut pas écrire dans la conversation de Kévin", async () => {
    const { deps, moteur } = creerContexte(REPONSE_SIMPLE);
    const premiers = await envoyer(deps, KEVIN, { texte: "Secret" });
    const id = premiers[0]?.type === "conversation" ? premiers[0].conversationId : "";
    const evenements = await envoyer(deps, ELODIE, { texte: "Lis ça", conversationId: id });
    expect(evenements).toEqual([
      { type: "erreur", idRequete: ID_REQUETE, code: "requete_invalide", message: "Conversation introuvable." },
    ]);
    expect(moteur.requetes).toHaveLength(1);
  });

  test("« réfléchis bien » passe sur Opus", async () => {
    const { deps, moteur } = creerContexte(REPONSE_SIMPLE);
    await envoyer(deps, KEVIN, { texte: "Réfléchis bien au menu" });
    expect(moteur.requetes[0]?.modele).toBe("opus");
  });

  test("session illisible : une seule relance, sans session, amorcée par l'historique", async () => {
    const { deps, depot, moteur } = creerContexte(
      REPONSE_SIMPLE,
      () => [{ type: "erreur", code: "moteur", message: "session introuvable" }],
      REPONSE_SIMPLE,
    );
    const premiers = await envoyer(deps, KEVIN, { texte: "Un" });
    const id = premiers[0]?.type === "conversation" ? premiers[0].conversationId : "";
    const evenements = await envoyer(deps, KEVIN, { texte: "Deux", conversationId: id });

    expect(moteur.requetes).toHaveLength(3);
    expect(moteur.requetes[1]?.sessionId).toBe("s1");
    expect(moteur.requetes[2]?.sessionId).toBeUndefined();
    expect(moteur.requetes[2]?.prompt).toContain("Utilisateur : Un");
    expect(moteur.requetes[2]?.prompt).toContain("Alicia : Il fait 19 °C.");
    expect(evenements.at(-1)?.type).toBe("fin");
    expect(depot.obtenir(id, "kevin")?.sessionId).toBe("s1");
  });

  test("quota atteint : erreur relayée, rien d'inventé, tour journalisé", async () => {
    const { deps, depot } = creerContexte(() => [
      { type: "erreur", code: "quota", message: "Je me repose : le quota de l'abonnement est atteint." },
    ]);
    const evenements = await envoyer(deps, KEVIN, { texte: "Salut" });
    const id = evenements[0]?.type === "conversation" ? evenements[0].conversationId : "";
    expect(evenements.at(-1)).toEqual({
      type: "erreur", idRequete: ID_REQUETE, conversationId: id, code: "quota",
      message: "Je me repose : le quota de l'abonnement est atteint.",
    });
    expect(depot.messages(id).map((m) => m.role)).toEqual(["utilisateur"]);
  });

  test("un moteur qui lève une exception devient une erreur « moteur »", async () => {
    const { deps } = creerContexte(() => {
      throw new Error("processus mort");
    });
    const evenements = await envoyer(deps, KEVIN, { texte: "Salut" });
    expect(evenements.at(-1)).toMatchObject({ type: "erreur", code: "moteur" });
  });

  test("relaie les appels d'outils", async () => {
    const { deps } = creerContexte(() => [
      { type: "appel_outil", idAppel: "t1", outil: "meteo" },
      { type: "resultat_outil", idAppel: "t1", succes: true },
      { type: "texte", texte: "Beau temps." },
      { type: "fin", tokensEntree: 1, tokensSortie: 1 },
    ]);
    const types = (await envoyer(deps, KEVIN, { texte: "Météo ?" })).map((e) => e.type);
    expect(types).toEqual(["conversation", "appel_outil", "resultat_outil", "morceau_texte", "fin"]);
  });
});
