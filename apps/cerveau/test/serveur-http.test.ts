import { describe, expect, test } from "vitest";
import { DepotConversations } from "../src/conversations/depot.ts";
import { ServiceAppairage } from "../src/identites/appairage.ts";
import { FauxMoteur } from "../src/moteur/faux-moteur.ts";
import { creerServeur } from "../src/serveur/serveur.ts";
import { creerBaseTest, creerHorlogeTest } from "./aides.ts";

async function creerContexte() {
  const base = creerBaseTest();
  const temps = creerHorlogeTest();
  const depot = new DepotConversations(base, temps.horloge);
  const appairage = new ServiceAppairage(base, temps.horloge);
  const moteur = new FauxMoteur(() => [{ type: "fin", tokensEntree: 0, tokensSortie: 0 }]);
  const app = await creerServeur({
    appairage, depot, version: "0.1.0", chat: { depot, moteur, horloge: temps.horloge, fuseau: "Europe/Paris" },
  });
  return { app, appairage, depot };
}

async function appairer(ctx: Awaited<ReturnType<typeof creerContexte>>, personne: string) {
  const code = ctx.appairage.genererCode(personne);
  const rep = await ctx.app.inject({ method: "POST", url: "/appairage", payload: { code, nomAppareil: "PC" } });
  return rep.json<{ jeton: string }>().jeton;
}

describe("serveur HTTP", () => {
  test("GET /sante", async () => {
    const { app } = await creerContexte();
    const rep = await app.inject({ method: "GET", url: "/sante" });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toEqual({ ok: true, version: "0.1.0" });
  });

  test("POST /appairage : bon code → jeton et personne", async () => {
    const ctx = await creerContexte();
    const code = ctx.appairage.genererCode("kevin");
    const rep = await ctx.app.inject({ method: "POST", url: "/appairage", payload: { code, nomAppareil: "PC" } });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ personne: { id: "kevin", nom: "Kévin" } });
  });

  test("POST /appairage : corps invalide → 400, mauvais code → 401", async () => {
    const { app } = await creerContexte();
    expect((await app.inject({ method: "POST", url: "/appairage", payload: { code: "abc" } })).statusCode).toBe(400);
    const rep = await app.inject({ method: "POST", url: "/appairage", payload: { code: "000000", nomAppareil: "PC" } });
    expect(rep.statusCode).toBe(401);
  });

  test("GET /conversations : 401 sans jeton, liste cloisonnée avec jeton", async () => {
    const ctx = await creerContexte();
    expect((await ctx.app.inject({ method: "GET", url: "/conversations" })).statusCode).toBe(401);
    ctx.depot.creer("kevin", "À Kévin");
    ctx.depot.creer("elodie", "À Élodie");
    const jeton = await appairer(ctx, "kevin");
    const rep = await ctx.app.inject({
      method: "GET", url: "/conversations", headers: { authorization: `Bearer ${jeton}` },
    });
    expect(rep.json<{ titre: string }[]>().map((c) => c.titre)).toEqual(["À Kévin"]);
  });

  test("GET /conversations/:id/messages : 404 sur la conversation d'un autre", async () => {
    const ctx = await creerContexte();
    const c = ctx.depot.creer("elodie", "Privé");
    ctx.depot.ajouterMessage(c.id, "utilisateur", "secret");
    const jeton = await appairer(ctx, "kevin");
    const rep = await ctx.app.inject({
      method: "GET", url: `/conversations/${c.id}/messages`, headers: { authorization: `Bearer ${jeton}` },
    });
    expect(rep.statusCode).toBe(404);
  });

  test("GET /conversations/:id/messages : historique avec dates ISO", async () => {
    const ctx = await creerContexte();
    const c = ctx.depot.creer("kevin", "T");
    ctx.depot.ajouterMessage(c.id, "utilisateur", "Bonjour");
    const jeton = await appairer(ctx, "kevin");
    const rep = await ctx.app.inject({
      method: "GET", url: `/conversations/${c.id}/messages`, headers: { authorization: `Bearer ${jeton}` },
    });
    expect(rep.json()).toEqual([
      { id: expect.any(String) as string, role: "utilisateur", texte: "Bonjour", creeLe: "2026-10-04T13:30:00.000Z" },
    ]);
  });
});
