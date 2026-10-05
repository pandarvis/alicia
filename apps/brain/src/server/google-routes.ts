import {
  GOOGLE_SCOPES, type GoogleAccountSummary, type GoogleConnectFailure, GoogleConnectRequest, type GoogleOAuthClient,
  type Person,
} from "@alicia/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { GoogleAccount } from "../google/account-store.ts";
import type { GoogleClient } from "../google/google-client.ts";
import { deviceAuth } from "./device-auth.ts";
import { sendError } from "./http-errors.ts";

export interface GoogleRoutesDependencies {
  /** Undefined when Google is not configured on this brain. */
  google: GoogleClient | undefined;
  /** The person behind the request's Bearer token, undefined if not authenticated. */
  personOf: (request: FastifyRequest) => Person | undefined;
}

const AccountId = z.uuid();

/** Seen from the caller, like memories: their own account is "personal". Never a token. */
function summary(account: GoogleAccount): GoogleAccountSummary {
  return {
    id: account.id,
    owner: account.owner === "common" ? "common" : "personal",
    email: account.email,
    status: account.status,
    connectedAt: new Date(account.updatedAt).toISOString(),
  };
}

/** Exhaustiveness: compiles only when every case was handled before. */
function unhandled(outcome: never): never {
  throw new Error(`Unhandled connect outcome: ${typeof outcome}`);
}

/** A Google-specific failure: `{ error }` with the protocol's word (the app tells the family what to do). */
function sendFailure(reply: FastifyReply, status: number, error: GoogleConnectFailure): FastifyReply {
  return reply.code(status).send({ error });
}

/**
 * `/google/*` routes: every one needs a Bearer token and acts within the caller's reach. Neither a token, nor the
 * code, nor the client secret is ever in an answer.
 */
export function registerGoogleRoutes(app: FastifyInstance, deps: GoogleRoutesDependencies): void {
  const { google, personOf } = deps;
  // Every route checks the device before its body is read.
  const auth = deviceAuth(personOf);
  const guard = { onRequest: auth.onRequest };

  /** The caller and the client, or the answer already sent (401, or 503 when Google is not configured). */
  function access(request: FastifyRequest, reply: FastifyReply): { person: Person; google: GoogleClient } | undefined {
    const person = auth.person(request);
    if (person === undefined) {
      void sendError(reply, 401, "unauthenticated");
      return undefined;
    }
    if (google === undefined) {
      void sendFailure(reply, 503, "google_unavailable");
      return undefined;
    }
    return { person, google };
  }

  app.get("/google/oauth-client", guard, (request, reply) => {
    const allowed = access(request, reply);
    if (allowed === undefined) return reply;
    const client: GoogleOAuthClient = { clientId: allowed.google.clientId, scopes: [...GOOGLE_SCOPES] };
    return client;
  });

  app.get("/google/accounts", guard, (request, reply) => {
    const allowed = access(request, reply);
    if (allowed === undefined) return reply;
    return allowed.google.list(allowed.person).map(summary);
  });

  // The app ran the browser flow; the brain exchanges the code with the client secret it alone holds.
  app.post("/google/accounts", guard, async (request, reply) => {
    const allowed = access(request, reply);
    if (allowed === undefined) return reply;
    const body = GoogleConnectRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const outcome = await allowed.google.connect(allowed.person, body.data);
    switch (outcome.status) {
      case "created":
        return reply.code(201).send(summary(outcome.account));
      case "updated":
        return reply.code(200).send(summary(outcome.account));
      case "conflict":
        // Connected by someone else (or as Famille): nothing revoked, the stored authorization stays valid.
        return sendFailure(reply, 409, "already_connected");
      case "missing_scopes":
        return sendFailure(reply, 422, "missing_scopes");
      case "exchange_failed":
        return sendFailure(reply, 400, "exchange_failed");
      case "unavailable":
        return sendFailure(reply, 502, "google_unreachable");
      default:
        // A new outcome must be mapped here before it can be built (and is never sent as it is: it may hold tokens).
        return unhandled(outcome);
    }
  });

  app.delete<{ Params: { id: string } }>("/google/accounts/:id", guard, async (request, reply) => {
    const allowed = access(request, reply);
    if (allowed === undefined) return reply;
    const id = AccountId.safeParse(request.params.id);
    if (!id.success || !(await allowed.google.remove(allowed.person, id.data))) return sendError(reply, 404, "not_found");
    return reply.code(204).send();
  });
}
