import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_NAME_HEADER, type AttachmentRefusalReason, attachmentTypeOf, type Person,
} from "@alicia/protocol";
import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from "fastify";
import { type AttachmentStore, cleanName, toSummary } from "../attachments/store.ts";
import { sendError } from "./http-errors.ts";

export interface AttachmentRouteDeps {
  attachments: AttachmentStore;
  personOf(request: FastifyRequest): Person | undefined;
}

const RAW = "application/octet-stream";
const REFUSAL_STATUS: Readonly<Record<AttachmentRefusalReason, number>> = {
  unsupported: 415, too_large: 413, empty: 400, too_many: 429,
};
/** Percent-encoded (up to 9 characters per one): a long name is accepted, then cut to 200 by the store. */
const NAME_HEADER_MAX = 4096;

/** The file name sent by the app (percent-encoded UTF-8), or undefined. Only ever used for display. */
function nameOf(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string" || header === "" || header.length > NAME_HEADER_MAX) return undefined;
  try {
    return decodeURIComponent(header);
  } catch {
    return undefined;
  }
}

/** Fastify's "body too large" error. */
function isTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 413;
}

/** The media type alone (without parameters), lower case. */
function mediaTypeOf(header: string | undefined): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Upload (raw bytes, 25 MB max) and removal of pending attachments, in their own encapsulated scope. An upload
 * belongs to the person of the device that sent it; nobody else can see, drop or send it.
 */
export function attachmentRoutes(deps: AttachmentRouteDeps): FastifyPluginCallback {
  return (scope: FastifyInstance, _options, done) => {
    // Only this scope accepts raw bodies, and up to 25 MB: Fastify counts the bytes as they arrive and stops
    // the upload (413) as soon as it goes over, without buffering the rest.
    scope.addContentTypeParser(RAW, { parseAs: "buffer", bodyLimit: ATTACHMENT_MAX_BYTES }, (_request, body, parsed) => {
      parsed(null, body);
    });

    // An upload over 25 MB, stopped by Fastify while it arrived: the app shows « Fichier trop gros ». Everything
    // else goes to the server's own error handler.
    scope.setErrorHandler((error, _request, reply) => {
      if (isTooLarge(error)) return sendError(reply, 413, "too_large");
      throw error;
    });

    // Who sent it, found once per upload (before the body is read).
    const senders = new WeakMap<FastifyRequest, Person>();

    scope.post("/attachments", {
      bodyLimit: ATTACHMENT_MAX_BYTES,
      // Everything that can be checked without the body is, before it is read: an unknown device, a missing name or
      // a refused type never pushes 25 MB.
      onRequest: (request, reply, next) => {
        const person = deps.personOf(request);
        if (person === undefined) {
          void sendError(reply, 401, "unauthenticated");
          return;
        }
        const name = nameOf(request.headers[ATTACHMENT_NAME_HEADER]);
        if (name === undefined) {
          void sendError(reply, 400, "invalid_request");
          return;
        }
        if (mediaTypeOf(request.headers["content-type"]) !== RAW || attachmentTypeOf(cleanName(name)) === undefined) {
          void sendError(reply, 415, "unsupported");
          return;
        }
        senders.set(request, person);
        next();
      },
    }, (request, reply) => {
      const person = senders.get(request);
      const name = nameOf(request.headers[ATTACHMENT_NAME_HEADER]);
      if (person === undefined || name === undefined) return sendError(reply, 400, "invalid_request");
      // An empty body may skip the parser (no buffer): the store then refuses it as empty.
      const bytes = request.body instanceof Buffer ? request.body : Buffer.alloc(0);
      deps.attachments.purgePending();
      const result = deps.attachments.upload(person.id, name, bytes);
      if (result.status === "refused") return sendError(reply, REFUSAL_STATUS[result.reason], result.reason);
      return reply.code(201).send(toSummary(result.attachment));
    });

    scope.delete<{ Params: { id: string } }>("/attachments/:id", (request, reply) => {
      const person = deps.personOf(request);
      if (person === undefined) return sendError(reply, 401, "unauthenticated");
      // Only the person's own pending uploads: someone else's, or one already sent, is "not found".
      return deps.attachments.discard(person.id, request.params.id)
        ? reply.code(204).send()
        : sendError(reply, 404, "not_found");
    });

    done();
  };
}
