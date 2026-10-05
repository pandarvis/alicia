import { ATTACHMENT_MAX_BYTES, ATTACHMENT_NAME_HEADER, type AttachmentRefusalReason, type Person } from "@alicia/protocol";
import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from "fastify";
import { type AttachmentStore, toSummary } from "../attachments/store.ts";
import { sendError } from "./http-errors.ts";

export interface AttachmentRouteDeps {
  attachments: AttachmentStore;
  personOf(request: FastifyRequest): Person | undefined;
}

const RAW = "application/octet-stream";
const REFUSAL_STATUS: Readonly<Record<AttachmentRefusalReason, number>> = { unsupported: 415, too_large: 413, empty: 400 };
/** Percent-encoded, a 200-character name (the most the store keeps) stays well under this. */
const NAME_HEADER_MAX = 1000;

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

    scope.post("/attachments", {
      bodyLimit: ATTACHMENT_MAX_BYTES,
      // Checked before the body is read: an unknown device cannot push 25 MB, nor anything but raw bytes.
      onRequest: (request, reply, next) => {
        if (deps.personOf(request) === undefined) {
          void sendError(reply, 401, "unauthenticated");
          return;
        }
        if (mediaTypeOf(request.headers["content-type"]) !== RAW) {
          void sendError(reply, 415, "unsupported");
          return;
        }
        next();
      },
    }, (request, reply) => {
      const person = deps.personOf(request);
      if (person === undefined) return sendError(reply, 401, "unauthenticated");
      const name = nameOf(request.headers[ATTACHMENT_NAME_HEADER]);
      if (name === undefined) return sendError(reply, 400, "invalid_request");
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
