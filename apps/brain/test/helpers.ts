import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Person } from "@alicia/protocol";
import { onTestFinished } from "vitest";
import type { Clock } from "../src/clock.ts";
import type { ChatDependencies, TurnPorts } from "../src/conversations/chat-service.ts";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { type Db, openDb } from "../src/db/open.ts";
import type { Engine, EngineRequest, NativeToolGuard } from "../src/engine/engine.ts";
import { syncPeople } from "../src/identity/people.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { ToolCatalog, type ToolProvider } from "../src/tools/catalog.ts";
import type { ConfirmationOutcome, ConfirmationRequest } from "../src/tools/confirmations.ts";
import { TurnContext } from "../src/tools/turn.ts";

export const KEVIN: Person = { id: "kevin", name: "Kévin" };
export const ELODIE: Person = { id: "elodie", name: "Élodie" };

/** Test clock: advanced by hand. */
export function createTestClock(start = Date.UTC(2026, 9, 4, 13, 30)) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** In-memory database with Kévin and Élodie. */
export function createTestDb() {
  const db = openDb(":memory:");
  syncPeople(db, [KEVIN, ELODIE]);
  return db;
}

/** Memory store with the deterministic embedder (never downloads a model). */
export function createTestMemory(db: Db, clock: Clock) {
  return new MemoryStore(db, new FakeEmbedder(), clock, { minSimilarity: 0.3 });
}

/** Chat dependencies on a test database; `extraTools` are added after the memory tools. */
export function createChatDeps(
  db: Db,
  clock: Clock,
  engine: Engine,
  extraTools: readonly ToolProvider[] = [],
): ChatDependencies {
  const memory = createTestMemory(db, clock);
  return {
    repository: new ConversationRepository(db, clock),
    engine,
    memory,
    tools: new ToolCatalog([memoryTools(memory), ...extraTools]),
    clock,
    timezone: "Europe/Paris",
  };
}

/** Ports answering every confirmation with `outcome`, and recording the questions. */
export function answeringPorts(outcome: ConfirmationOutcome) {
  const asked: ConfirmationRequest[] = [];
  const ports: TurnPorts = {
    confirm: (_where, request) => {
      asked.push(request);
      return Promise.resolve(outcome);
    },
    confirmationTimeoutMs: 300_000,
  };
  return { ports, asked };
}

/**
 * A turn context for tool tests: every confirmation gets `outcome` (or what `answer` resolves to); `end` ends
 * the turn, as handleSend does when it finishes.
 */
export function createTestTurn(
  person: Person,
  conversationId: string,
  outcome: ConfirmationOutcome | (() => Promise<ConfirmationOutcome>) = "approved",
) {
  const asked: ConfirmationRequest[] = [];
  const scope = new AbortController();
  const turn = new TurnContext({
    person,
    conversationId,
    signal: scope.signal,
    confirm: (request) => {
      asked.push(request);
      return typeof outcome === "function" ? outcome() : Promise.resolve(outcome);
    },
  });
  return {
    turn,
    asked,
    end: () => {
      scope.abort();
    },
  };
}

/** A temporary directory removed when the current test ends (call it inside a test). */
export function createTempDir(prefix = "alicia-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return dir;
}

/** Guard refusing every built-in tool (tests that do not use them). */
export const DENY_NATIVE: NativeToolGuard = {
  check: () => Promise.resolve({ allow: false, reason: "Cet outil n'est pas disponible." }),
  reminder: () => undefined,
};

/** An engine request for tests: no tools, built-in tools refused, nothing readable. */
export function testRequest(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    prompt: "x", sessionId: undefined, model: "sonnet", systemPrompt: "c", tools: [], guard: DENY_NATIVE, readableDirs: [],
    toolTimeoutMs: 360_000,
    ...overrides,
  };
}
