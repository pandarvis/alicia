import websocket from "@fastify/websocket";
import {
  type MessageHistorique,
  type Personne,
  RequeteAppairage,
  type ResumeConversation,
} from "@alicia/protocole";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { DepotConversations } from "../conversations/depot.ts";
import type { DependancesChat } from "../conversations/service-chat.ts";
import type { ServiceAppairage } from "../identites/appairage.ts";
import { brancherWs } from "./ws.ts";

export interface DependancesServeur {
  appairage: ServiceAppairage;
  depot: DepotConversations;
  chat: DependancesChat;
  version: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function creerServeur(deps: DependancesServeur): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  // 128 Kio : le protocole plafonne les messages à 20 000 caractères.
  await app.register(websocket, { options: { maxPayload: 131_072 } });

  const personneDe = (requete: FastifyRequest): Personne | undefined => {
    const entete = requete.headers.authorization;
    if (entete?.startsWith("Bearer ") !== true) return undefined;
    return deps.appairage.authentifier(entete.slice("Bearer ".length));
  };

  app.get("/sante", () => ({ ok: true as const, version: deps.version }));

  app.post("/appairage", (requete, reponse) => {
    const corps = RequeteAppairage.safeParse(requete.body);
    if (!corps.success) return reponse.code(400).send({ erreur: "requete_invalide" });
    const resultat = deps.appairage.echanger(corps.data.code, corps.data.nomAppareil);
    if ("erreur" in resultat) {
      return reponse.code(resultat.erreur === "trop_de_tentatives" ? 429 : 401).send({ erreur: resultat.erreur });
    }
    return resultat;
  });

  app.get("/conversations", (requete, reponse) => {
    const personne = personneDe(requete);
    if (personne === undefined) return reponse.code(401).send({ erreur: "non_authentifie" });
    const liste: ResumeConversation[] = deps.depot
      .lister(personne.id)
      .map((c) => ({ id: c.id, titre: c.titre, majLe: iso(c.majLe) }));
    return liste;
  });

  app.get<{ Params: { id: string } }>("/conversations/:id/messages", (requete, reponse) => {
    const personne = personneDe(requete);
    if (personne === undefined) return reponse.code(401).send({ erreur: "non_authentifie" });
    if (deps.depot.obtenir(requete.params.id, personne.id) === undefined) {
      return reponse.code(404).send({ erreur: "introuvable" });
    }
    const liste: MessageHistorique[] = deps.depot
      .messages(requete.params.id)
      .map((m) => ({ id: m.id, role: m.role, texte: m.texte, creeLe: iso(m.creeLe) }));
    return liste;
  });

  app.get("/ws", { websocket: true }, (socket) => {
    brancherWs(socket, deps);
  });

  return app;
}
