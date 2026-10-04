import type { AddressInfo } from "node:net";
import { EvenementServeur } from "@alicia/protocole";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { DepotConversations } from "../src/conversations/depot.ts";
import { ServiceAppairage } from "../src/identites/appairage.ts";
import { FauxMoteur } from "../src/moteur/faux-moteur.ts";
import type { EvenementMoteur, Moteur } from "../src/moteur/moteur.ts";
import { creerServeur } from "../src/serveur/serveur.ts";
import { creerBaseTest, creerHorlogeTest } from "./aides.ts";

const ID_REQUETE = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
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
  const moteur =
    options.moteur ??
    new FauxMoteur(() => [
      { type: "session", sessionId: "s1" },
      { type: "texte", texte: "Coucou !" },
      { type: "fin", tokensEntree: 3, tokensSortie: 2 },
    ]);
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
  return { url: `ws://127.0.0.1:${port}/ws`, jeton: r.jeton };
}

/** Ouvre une connexion et accumule les événements reçus (validés par le protocole). */
function connecter(url: string) {
  const ws = new WebSocket(url);
  const recus: EvenementServeur[] = [];
  const attentes: { condition: (e: EvenementServeur) => boolean; resoudre: () => void }[] = [];
  ws.on("message", (donnees: WebSocket.RawData) => {
    const texte = Buffer.isBuffer(donnees) ? donnees.toString("utf8") : "";
    recus.push(EvenementServeur.parse(JSON.parse(texte)));
    for (const a of attentes.filter((x) => recus.some(x.condition))) a.resoudre();
  });
  const ouvert = new Promise<void>((resoudre) => ws.once("open", () => { resoudre(); }));
  const ferme = new Promise<number>((resoudre) => ws.once("close", (code) => { resoudre(code); }));
  const attendre = (condition: (e: EvenementServeur) => boolean) =>
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
    await c.attendre((e) => e.type === "erreur");
    expect(c.recus[0]).toMatchObject({ type: "erreur", code: "non_authentifie" });
    c.ws.close();
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
});
