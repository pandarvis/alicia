import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { systemClock } from "./clock.ts";
import type { Authentication, Config } from "./config.ts";
import { ConversationRepository } from "./conversations/repository.ts";
import { openDb } from "./db/open.ts";
import type { Engine } from "./engine/engine.ts";
import { SdkEngine } from "./engine/sdk-engine.ts";
import { Maintenance } from "./maintenance.ts";
import { PairingService } from "./identity/pairing.ts";
import { syncPeople } from "./identity/people.ts";
import type { Embedder } from "./memory/embedder.ts";
import { MemoryStore } from "./memory/store.ts";
import { memoryTools } from "./memory/tools.ts";
import { TransformersEmbedder } from "./memory/transformers-embedder.ts";
import { createServer } from "./server/server.ts";
import { ToolCatalog } from "./tools/catalog.ts";
import { listSkills } from "./tools/skills.ts";
import { VERSION } from "./version.ts";

/** cwd of the SDK process. */
export const WORKSPACE_DIR = fileURLToPath(new URL("../workspace", import.meta.url));
/** Alicia's skills (instructions only): the only ones the SDK loads. */
export const SKILLS_DIR = join(WORKSPACE_DIR, ".claude", "skills");

export interface ApplicationOptions {
  /** Fastify logger (pino, Authorization masked): enabled by `start`, off by default. */
  logging?: boolean;
  /** Memory embedder (default: the local multilingual model, loaded lazily on first use). */
  embedder?: Embedder;
}

export interface Application {
  server: FastifyInstance;
  memory: MemoryStore;
  pairing: PairingService;
  /** Nightly job (backup, journal rotation): started by `start` only, never by the maintenance commands. */
  maintenance: Maintenance;
  /** Stops the nightly job, closes the server (and its WebSockets), then the database. */
  close(): Promise<void>;
}

export function createSdkEngine(config: Config, auth: Authentication): Engine {
  return new SdkEngine({ auth, models: config.models, workspaceDir: WORKSPACE_DIR, skills: listSkills(SKILLS_DIR) });
}

/**
 * The database and the memory store built on it (shared by the server and the CLI maintenance commands).
 * Startup upkeep lives here, so every path that opens the memory gets it: the full-text index is
 * rebuilt and memories forgotten for more than 30 days are purged. The embedding model is never
 * touched here (it loads on first embedding only).
 */
function openCore(config: Config, embedder?: Embedder) {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, "alicia.db"));
  try {
    syncPeople(db, config.people);
    const memory = new MemoryStore(db, embedder ?? new TransformersEmbedder(join(config.dataDir, "models")), systemClock);
    memory.rebuildIndex();
    memory.purgeForgotten();
    return { db, memory };
  } catch (error) {
    db.$client.close();
    throw error;
  }
}

/** Opens the database and the memory store without starting the HTTP server. */
export function openMemory(config: Config, embedder?: Embedder): { memory: MemoryStore; close: () => void } {
  const { db, memory } = openCore(config, embedder);
  return { memory, close: () => db.$client.close() };
}

export async function buildApplication(
  config: Config,
  engine: Engine,
  options: ApplicationOptions = {},
): Promise<Application> {
  const { db, memory } = openCore(config, options.embedder);
  try {
    // <dataDir>/updates: where a new version of the desktop app is dropped (README, « Publier une version »).
    // Absolute (@fastify/static refuses a relative root), whatever the config says (`./data` by default).
    const updatesDir = resolve(config.dataDir, "updates");
    mkdirSync(updatesDir, { recursive: true });
    const repository = new ConversationRepository(db, systemClock);
    const pairing = new PairingService(db, systemClock);
    const maintenance = new Maintenance({
      sqlite: db.$client,
      repository,
      backupDir: join(config.dataDir, "backups"),
      timezone: config.timezone,
      clock: systemClock,
    });
    const tools = new ToolCatalog([memoryTools(memory)]);
    // Two tools with one name would only fail on the first turn: refuse to start instead.
    const someone = config.people[0];
    if (someone !== undefined) tools.checkNames({ person: someone, conversationId: randomUUID() });
    const server = await createServer({
      pairing,
      repository,
      version: VERSION,
      chat: { repository, engine, memory, tools, clock: systemClock, timezone: config.timezone },
      allowedOrigins: config.allowedOrigins,
      updatesDir,
      ...(options.logging !== undefined ? { logging: options.logging } : {}),
    });

    return {
      server,
      memory,
      pairing,
      maintenance,
      close: async () => {
        await maintenance.stop();
        await server.close();
        db.$client.close();
      },
    };
  } catch (error) {
    db.$client.close();
    throw error;
  }
}
