import type { AddressInfo } from "node:net";
import { ServerEvent } from "@alicia/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { DepotConversations } from "../src/conversations/repository.ts";
import { ServiceAppairage } from "../src/identity/pairing.ts";
import { FauxMoteur } from "../src/engine/fake-engine.ts";
import type { EvenementMoteur, Moteur } from "../src/engine/engine.ts";
import { creerServeur } from "../src/server/server.ts";
import { creerBaseTest, creerHorlogeTest } from "./helpers.ts";

const ID_REQUETE = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const ID_REQUETE_2 = "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6";
const ID_REQUETE_3 = "c9d8e7f6-5a4b-4c3d-9e2f-0a1b2c3d4e5f";
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface OptionsDemarrage {
  moteur?: Moteur;
  delaiAuthentificationMs?: number;
}

async function demarrer(options: OptionsDemarrage = {}) {
  const base = creerBaseTest();
  const temps = creerHorlogeTest();
  const depot = new DepotConversations(base, temps.horloge);
  const appairage = new ServiceAppairage(base, temps.horloge);
  const fauxMoteur = new FauxMoteur(() => [
    { type: "session", sessionId: "s1" },
    { type: "texte", texte: "Coucou !" },
    { type: "fin", tokensEntree: 3, tokensSortie: 2 },
  ]);
  const moteur = options.moteur ?? fauxMoteur;
  app = await creerServeur({
    appairage,
    depot,
    version: "0.1.0",
    chat: { depot, moteur, horloge: temps.horloge, fuseau: "Europe/Paris" },
    ...(options.delaiAuthentificationMs === undefined
      ? {}
      : { delaiAuthentificationMs: options.delaiAuthentificationMs }),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const r = appairage.echanger(appairage.genererCode("kevin"), "PC");
  if ("erreur" in r) throw new Error(r.erreur);
  const jetonElodie = appairage.echanger(appairage.genererCode("elodie"), "Tablette");
  if ("erreur" in jetonElodie) throw new Error(jetonElodie.erreur);
  return {
    url: `ws://127.0.0.1:${port}/ws`, jeton: r.jeton, jetonElodie: jetonElodie.jeton, appairage, depot, fauxMoteur,
  };
}

/** Ouvre une connexion et accumule les événements reçus (validés par le protocole). */
function connecter(url: string) {
  const ws = new WebSocket(url);
  const recus: ServerEvent[] = [];
  const attentes: { condition: (e: ServerEvent) => boolean; resoudre: () => void }[] = [];
  ws.on("message", (donnees: WebSocket.RawData) => {
    const texte = Buffer.isBuffer(donnees) ? donnees.toString("utf8") : "";
    recus.push(ServerEvent.parse(JSON.parse(texte)));
    for (const a of attentes.filter((x) => recus.some(x.condition))) a.resoudre();
  });
  const ouvert = new Promise<void>((resoudre) => ws.once("open", () => { resoudre(); }));
  const ferme = new Promise<number>((resoudre) => ws.once("close", (code) => { resoudre(code); }));
  const attendre = (condition: (e: ServerEvent) => boolean) =>
    new Promise<void>((resoudre) => {
      if (recus.some(condition)) resoudre();
      else attentes.push({ condition, resoudre });
    });
  return { ws, recus, ouvert, ferme, attendre };
}

describe("WebSocket", () => {
  test("authentification puis conversation complète", async () => {
    const { url, jeton } = await demarrer();
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    await c.attendre((e) => e.type === "pret");
    c.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Salut" }));
    await c.attendre((e) => e.type === "fin");
    expect(c.recus.map((e) => e.type)).toEqual(["pret", "conversation", "morceau_texte", "fin"]);
    expect(c.recus[0]).toEqual({ type: "pret", personne: { id: "kevin", nom: "Kévin" } });
    c.ws.close();
  });

  test("mauvais jeton : erreur puis fermeture 4401", async () => {
    const { url } = await demarrer();
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "authentifier", jeton: "x".repeat(43) }));
    expect(await c.ferme).toBe(4401);
    expect(c.recus).toEqual([{ type: "erreur", code: "non_authentifie", message: "Jeton refusé." }]);
  });

  test("envoi avant authentification : refusé", async () => {
    const { url } = await demarrer();
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Salut" }));
    expect(await c.ferme).toBe(4401);
    expect(c.recus).toEqual([{ type: "erreur", code: "non_authentifie", message: "Authentification attendue." }]);
  });

  test("message illisible avant authentification : refusé et fermeture 4401", async () => {
    const { url } = await demarrer();
    const c = connecter(url);
    await c.ouvert;
    c.ws.send("pas du json");
    expect(await c.ferme).toBe(4401);
    expect(c.recus).toEqual([{ type: "erreur", code: "non_authentifie", message: "Authentification attendue." }]);
  });

  test("message mal formé : requete_invalide, la connexion reste ouverte", async () => {
    const { url, jeton } = await demarrer();
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    await c.attendre((e) => e.type === "pret");
    c.ws.send("pas du json");
    await c.attendre((e) => e.type === "erreur");
    expect(c.recus.at(-1)).toMatchObject({ code: "requete_invalide" });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  test("sans authentification dans le délai : erreur puis fermeture 4401", async () => {
    const { url } = await demarrer({ delaiAuthentificationMs: 50 });
    const c = connecter(url);
    await c.ouvert;
    expect(await c.ferme).toBe(4401);
    expect(c.recus).toEqual([
      { type: "erreur", code: "non_authentifie", message: "Authentification attendue." },
    ]);
  });

  test("fermer la connexion en plein tour annule le tour", async () => {
    let signalDuTour: AbortSignal | undefined;
    let demarreTour: () => void = () => undefined;
    const tourDemarre = new Promise<void>((resoudre) => {
      demarreTour = resoudre;
    });
    const moteur: Moteur = {
      executer(_requete, signal): AsyncIterable<EvenementMoteur> {
        signalDuTour = signal;
        return (async function* () {
          yield { type: "texte", texte: "Je réfléchis" } satisfies EvenementMoteur;
          demarreTour();
          await new Promise<void>((resoudre) => {
            if (signal.aborted) resoudre();
            else signal.addEventListener("abort", () => { resoudre(); }, { once: true });
          });
        })();
      },
    };
    const { url, jeton } = await demarrer({ moteur });
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    await c.attendre((e) => e.type === "pret");
    c.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Salut" }));
    await tourDemarre;
    expect(signalDuTour?.aborted).toBe(false);

    const fermee = new Promise<void>((resoudre) => {
      signalDuTour?.addEventListener("abort", () => { resoudre(); }, { once: true });
    });
    c.ws.close();
    await fermee;
    expect(signalDuTour?.aborted).toBe(true);
  });
  test("l'identité est figée : un second authentifier est refusé", async () => {
    const { url, jeton, jetonElodie, fauxMoteur } = await demarrer();
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    await c.attendre((e) => e.type === "pret");
    c.ws.send(JSON.stringify({ type: "authentifier", jeton: jetonElodie }));
    await c.attendre((e) => e.type === "erreur");
    expect(c.recus.at(-1)).toEqual({ type: "erreur", code: "requete_invalide", message: "Déjà authentifié." });
    expect(c.recus.filter((e) => e.type === "pret")).toHaveLength(1);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);

    c.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Salut" }));
    await c.attendre((e) => e.type === "fin");
    expect(fauxMoteur.requetes[0]?.consigneSysteme).toContain("Tu parles avec Kévin.");
    c.ws.close();
  });

  test("un seul tour à la fois par connexion", async () => {
    let appels = 0;
    let liberer: () => void = () => undefined;
    const liberation = new Promise<void>((resoudre) => {
      liberer = resoudre;
    });
    let demarre: () => void = () => undefined;
    const premierDemarre = new Promise<void>((resoudre) => {
      demarre = resoudre;
    });
    const moteur: Moteur = {
      executer(): AsyncIterable<EvenementMoteur> {
        appels += 1;
        const numero = appels;
        return (async function* () {
          yield { type: "texte", texte: "…" } satisfies EvenementMoteur;
          if (numero === 1) {
            demarre();
            await liberation;
          }
          yield { type: "fin", tokensEntree: 1, tokensSortie: 1 } satisfies EvenementMoteur;
        })();
      },
    };
    const { url, jeton } = await demarrer({ moteur });
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    await c.attendre((e) => e.type === "pret");
    c.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Un" }));
    await premierDemarre;

    c.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE_2, texte: "Deux" }));
    await c.attendre((e) => e.type === "erreur");
    expect(c.recus.at(-1)).toEqual({
      type: "erreur",
      idRequete: ID_REQUETE_2,
      code: "occupe",
      message: "Alicia répond déjà ; réessaie après sa réponse.",
    });
    expect(appels).toBe(1);

    liberer();
    await c.attendre((e) => e.type === "fin");
    c.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE_3, texte: "Trois" }));
    await c.attendre((e) => e.type === "conversation" && e.idRequete === ID_REQUETE_3);
    expect(appels).toBe(2);
    c.ws.close();
  });

  test("appareil révoqué pendant la connexion : l'envoi suivant est refusé et la connexion fermée 4401", async () => {
    const { url, jeton, appairage, fauxMoteur } = await demarrer();
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    await c.attendre((e) => e.type === "pret");

    const pc = appairage.listerAppareils().find((a) => a.personneId === "kevin");
    expect(appairage.revoquerAppareil(pc?.id ?? "")).toBe(true);

    c.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Salut" }));
    expect(await c.ferme).toBe(4401);
    expect(c.recus.slice(1)).toEqual([{ type: "erreur", code: "non_authentifie", message: "Appareil révoqué." }]);
    expect(fauxMoteur.requetes).toHaveLength(0);
  });

  test("un seul tour à la fois par conversation, tous appareils confondus", async () => {
    // 1er appel : rapide (crée la conversation C) ; 2e et 3e appels : bloqués jusqu'à libération.
    let appels = 0;
    let liberer: () => void = () => undefined;
    const liberation = new Promise<void>((resoudre) => {
      liberer = resoudre;
    });
    let demarre: () => void = () => undefined;
    const tourBloqueDemarre = new Promise<void>((resoudre) => {
      demarre = resoudre;
    });
    const moteur: Moteur = {
      executer(): AsyncIterable<EvenementMoteur> {
        appels += 1;
        const numero = appels;
        return (async function* () {
          yield { type: "texte", texte: "…" } satisfies EvenementMoteur;
          if (numero === 2) demarre();
          if (numero === 2 || numero === 3) await liberation;
          yield { type: "fin", tokensEntree: 1, tokensSortie: 1 } satisfies EvenementMoteur;
        })();
      },
    };
    const { url, jeton, appairage } = await demarrer({ moteur });
    const second = appairage.echanger(appairage.genererCode("kevin"), "Téléphone Kévin");
    if ("erreur" in second) throw new Error(second.erreur);

    const a = connecter(url);
    const b = connecter(url);
    await Promise.all([a.ouvert, b.ouvert]);
    a.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    b.ws.send(JSON.stringify({ type: "authentifier", jeton: second.jeton }));
    await Promise.all([a.attendre((e) => e.type === "pret"), b.attendre((e) => e.type === "pret")]);

    a.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Un" }));
    await a.attendre((e) => e.type === "fin");
    const conversation = a.recus.find((e) => e.type === "conversation");
    const conversationId = conversation?.type === "conversation" ? conversation.conversationId : "";

    a.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE_2, texte: "Deux", conversationId }));
    await tourBloqueDemarre;

    b.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE_3, texte: "Trois", conversationId }));
    await b.attendre((e) => e.type === "erreur");
    expect(b.recus.at(-1)).toEqual({
      type: "erreur",
      idRequete: ID_REQUETE_3,
      code: "occupe",
      message: "Alicia répond déjà dans cette conversation.",
    });
    expect(appels).toBe(2);

    // Une nouvelle conversation n'est jamais bloquée.
    const ID_NOUVELLE = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    b.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_NOUVELLE, texte: "Ailleurs" }));
    await b.attendre((e) => e.type === "conversation" && e.idRequete === ID_NOUVELLE);
    expect(appels).toBe(3);

    liberer();
    await a.attendre((e) => e.type === "fin" && a.recus.filter((x) => x.type === "fin").length === 2);
    await b.attendre((e) => e.type === "fin");

    const ID_APRES = "1c2d3e4f-5061-4b7c-9d8e-0f1a2b3c4d5e";
    b.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_APRES, texte: "Quatre", conversationId }));
    await b.attendre((e) => e.type === "conversation" && e.idRequete === ID_APRES);
    expect(b.recus.find((e) => e.type === "conversation" && e.idRequete === ID_APRES)).toEqual({
      type: "conversation", idRequete: ID_APRES, conversationId,
    });
    await b.attendre((e) => e.type === "fin" && b.recus.filter((x) => x.type === "fin").length === 2);
    expect(appels).toBe(4);
    a.ws.close();
    b.ws.close();
  });

  test("une conversation tout juste créée est verrouillée dès que son id est connu", async () => {
    let liberer: () => void = () => undefined;
    const liberation = new Promise<void>((resoudre) => {
      liberer = resoudre;
    });
    let appels = 0;
    const moteur: Moteur = {
      executer(): AsyncIterable<EvenementMoteur> {
        appels += 1;
        return (async function* () {
          yield { type: "texte", texte: "…" } satisfies EvenementMoteur;
          await liberation;
          yield { type: "fin", tokensEntree: 1, tokensSortie: 1 } satisfies EvenementMoteur;
        })();
      },
    };
    const { url, jeton, appairage } = await demarrer({ moteur });
    const second = appairage.echanger(appairage.genererCode("kevin"), "Téléphone Kévin");
    if ("erreur" in second) throw new Error(second.erreur);
    const a = connecter(url);
    const b = connecter(url);
    await Promise.all([a.ouvert, b.ouvert]);
    a.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    b.ws.send(JSON.stringify({ type: "authentifier", jeton: second.jeton }));
    await Promise.all([a.attendre((e) => e.type === "pret"), b.attendre((e) => e.type === "pret")]);

    a.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Un" }));
    await a.attendre((e) => e.type === "morceau_texte");
    const conversation = a.recus.find((e) => e.type === "conversation");
    const conversationId = conversation?.type === "conversation" ? conversation.conversationId : "";

    b.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE_2, texte: "Deux", conversationId }));
    await b.attendre((e) => e.type === "erreur");
    expect(b.recus.at(-1)).toMatchObject({ idRequete: ID_REQUETE_2, code: "occupe" });
    expect(appels).toBe(1);

    liberer();
    await a.attendre((e) => e.type === "fin");
    a.ws.close();
    b.ws.close();
  });

  test("la conversation d'une autre personne est introuvable et reste intacte", async () => {
    const { url, jeton, jetonElodie, depot, fauxMoteur } = await demarrer();
    const k = connecter(url);
    await k.ouvert;
    k.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    await k.attendre((e) => e.type === "pret");
    k.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE, texte: "Secret de Kévin" }));
    await k.attendre((e) => e.type === "fin");
    const conversation = k.recus.find((e) => e.type === "conversation");
    const conversationId = conversation?.type === "conversation" ? conversation.conversationId : "";
    const avant = depot.messages(conversationId);
    expect(avant).toHaveLength(2);

    const e = connecter(url);
    await e.ouvert;
    e.ws.send(JSON.stringify({ type: "authentifier", jeton: jetonElodie }));
    await e.attendre((x) => x.type === "pret");
    e.ws.send(JSON.stringify({ type: "envoyer", idRequete: ID_REQUETE_2, texte: "Je m'invite", conversationId }));
    await e.attendre((x) => x.type === "erreur");
    expect(e.recus.slice(1)).toEqual([
      { type: "erreur", idRequete: ID_REQUETE_2, code: "requete_invalide", message: "Conversation introuvable." },
    ]);
    expect(depot.messages(conversationId)).toEqual(avant);
    expect(depot.lister("elodie")).toHaveLength(0);
    expect(fauxMoteur.requetes).toHaveLength(1);
    expect(e.ws.readyState).toBe(WebSocket.OPEN);
    k.ws.close();
    e.ws.close();
  });

  test("une exception synchrone ne fait pas tomber le processus : erreur interne et fermeture 1011", async () => {
    const { url, jeton, appairage } = await demarrer();
    vi.spyOn(appairage, "authentifierAppareil").mockImplementation(() => {
      throw new Error("base cassée");
    });
    const c = connecter(url);
    await c.ouvert;
    c.ws.send(JSON.stringify({ type: "authentifier", jeton }));
    expect(await c.ferme).toBe(1011);
    expect(c.recus).toEqual([{ type: "erreur", code: "interne", message: "Erreur interne." }]);
  });
});
