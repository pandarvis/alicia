import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { systemClock } from "./clock.ts";
import type { Authentication, Config } from "./config.ts";
import { ConversationRepository } from "./conversations/repository.ts";
import { openDb } from "./db/open.ts";
import type { Engine } from "./engine/engine.ts";
import { SdkEngine } from "./engine/sdk-engine.ts";
import { PairingService } from "./identity/pairing.ts";
import { syncPeople } from "./identity/people.ts";
import { createServer } from "./server/server.ts";
import { VERSION } from "./version.ts";

/** cwd of the SDK process (skills in plan 3). */
export const WORKSPACE_DIR = fileURLToPath(new URL("../workspace", import.meta.url));

export interface ApplicationOptions {
  /** Fastify logger (pino, Authorization masked): enabled by `start`, off by default. */
  logging?: boolean;
}

export interface Application {
  server: FastifyInstance;
  pairing: PairingService;
  /** Closes the server (and its WebSockets), then the database. */
  close(): Promise<void>;
}

export function createSdkEngine(config: Config, auth: Authentication): Engine {
  return new SdkEngine({ auth, models: config.models, workspaceDir: WORKSPACE_DIR });
}

export async function buildApplication(
  config: Config,
  engine: Engine,
  options: ApplicationOptions = {},
): Promise<Application> {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, "alicia.db"));
  try {
    syncPeople(db, config.people);

    const repository = new ConversationRepository(db, systemClock);
    const pairing = new PairingService(db, systemClock);
    const server = await createServer({
      pairing,
      repository,
      version: VERSION,
      chat: { repository, engine, clock: systemClock, timezone: config.timezone },
      ...(options.logging !== undefined ? { logging: options.logging } : {}),
    });

    return {
      server,
      pairing,
      close: async () => {
        await server.close();
        db.$client.close();
      },
    };
  } catch (error) {
    db.$client.close();
    throw error;
  }
}
