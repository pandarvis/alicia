import websocket from "@fastify/websocket";
import {
  type MessageHistorique,
  type Personne,
  RequeteAppairage,
  type ResumeConversation,
} from "@alicia/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { DepotConversations } from "../conversations/depot.ts";
import type { DependancesChat } from "../conversations/service-chat.ts";
import type { ServiceAppairage } from "../identites/appairage.ts";
import { VerrouConversations } from "./verrou-conversations.ts";
import { brancherWs } from "./ws.ts";

export interface DependancesServeur {
  appairage: ServiceAppairage;
  depot: DepotConversations;
  chat: DependancesChat;
  version: string;
  /** Délai laissé au client pour s'authentifier (défaut 5 s ; réglable pour les tests). */
  delaiAuthentificationMs?: number;
  /** Journal pino de Fastify (défaut : coupé, pour des tests silencieux). */
  journal?: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Schéma « Bearer » insensible à la casse (RFC 7235). */
const BEARER = /^bearer +(\S+)$/i;

/** Statut 4xx porté par une erreur Fastify (JSON mal formé, corps trop gros…), sinon undefined. */
function statutClient(erreur: unknown): number | undefined {
  if (typeof erreur !== "object" || erreur === null || !("statusCode" in erreur)) return undefined;
  const statut = erreur.statusCode;
  return typeof statut === "number" && statut >= 400 && statut < 500 ? statut : undefined;
}

export async function creerServeur(deps: DependancesServeur): Promise<FastifyInstance> {
  const app = Fastify({
    // Jamais l'en-tête Authorization dans le journal ; les corps et les messages n'y sont pas écrits.
    logger: deps.journal === true ? { redact: ["req.headers.authorization"] } : false,
    bodyLimit: 1_048_576,
  });

  // Aucune erreur ne fuit vers le client : 4xx → requete_invalide, le reste → interne (détail au journal).
  app.setErrorHandler((erreur, requete, reponse) => {
    const statut = statutClient(erreur);
    if (statut !== undefined) {
      requete.log.warn({ statut }, "requête refusée");
      return reponse.code(statut).send({ erreur: "requete_invalide" });
    }
    requete.log.error({ err: erreur }, "erreur interne");
    return reponse.code(500).send({ erreur: "interne" });
  });

  // 128 Kio : le protocole plafonne les messages à 20 000 caractères.
  await app.register(websocket, { options: { maxPayload: 131_072 } });

  const personneDe = (requete: FastifyRequest): Personne | undefined => {
    const jeton = BEARER.exec(requete.headers.authorization ?? "")?.[1];
    return jeton === undefined ? undefined : deps.appairage.authentifier(jeton);
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

  // Partagé par toutes les connexions : un seul tour à la fois par conversation.
  const verrou = new VerrouConversations();
  app.get("/ws", { websocket: true }, (socket) => {
    brancherWs(socket, deps, verrou);
  });

  return app;
}
