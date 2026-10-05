import type { Person } from "@alicia/protocol";
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { sendError } from "./http-errors.ts";

/** The device check of a route, done before its body is read: an unknown caller never gets a body parsed. */
export interface DeviceAuth {
  /** Route `onRequest` hook: 401 at once for an unknown or revoked device token. */
  onRequest: (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void;
  /** The person the hook found for this request (undefined only on a route without the hook). */
  person: (request: FastifyRequest) => Person | undefined;
}

export function deviceAuth(personOf: (request: FastifyRequest) => Person | undefined): DeviceAuth {
  const people = new WeakMap<FastifyRequest, Person>();
  return {
    onRequest: (request, reply, done) => {
      const person = personOf(request);
      if (person === undefined) {
        void sendError(reply, 401, "unauthenticated");
        return;
      }
      people.set(request, person);
      done();
    },
    person: (request) => people.get(request),
  };
}
