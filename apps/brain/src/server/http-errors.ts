import type { HttpErrorBody, HttpErrorCode, MemoryRefusalReason } from "@alicia/protocol";
import type { FastifyReply } from "fastify";

export type PlainErrorCode = Exclude<HttpErrorCode, "refused">;

/** French on purpose: the app may show them to the family as they are. */
const MESSAGES: Readonly<Record<HttpErrorCode, string>> = {
  invalid_request: "Requête invalide.",
  unauthenticated: "Appareil non reconnu : il faut l'appairer à nouveau.",
  not_found: "Introuvable.",
  busy: "Alicia répond déjà dans cette conversation.",
  duplicate: "Ce souvenir existe déjà.",
  refused: "Souvenir refusé.",
  invalid_code: "Code d'appairage invalide ou expiré.",
  too_many_attempts: "Trop d'essais : réessaie dans quelques minutes.",
  forbidden_origin: "Origine non autorisée.",
  too_large: "Fichier trop gros : 25 Mo au maximum.",
  unsupported: "Type de fichier non pris en charge : images, PDF, Word (.docx), Excel (.xlsx) et texte (.txt, .csv).",
  empty: "Fichier vide.",
  internal: "Erreur interne du cerveau.",
};

export function errorBody(code: PlainErrorCode): HttpErrorBody {
  return { error: { code, message: MESSAGES[code] } };
}

export function refusedBody(reason: MemoryRefusalReason): HttpErrorBody {
  return { error: { code: "refused", message: MESSAGES.refused, reason } };
}

/** Sends a typed error; returns the reply so a handler can `return sendError(...)`. */
export function sendError(reply: FastifyReply, status: number, code: PlainErrorCode): FastifyReply {
  return reply.code(status).send(errorBody(code));
}
