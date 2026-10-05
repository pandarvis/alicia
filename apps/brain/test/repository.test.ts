import { describe, expect, test } from "vitest";
import { messages, turnLog } from "../src/db/schema.ts";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { createTestClock, createTestDb, createTestMemory } from "./helpers.ts";

function createRepository() {
  const db = createTestDb();
  const time = createTestClock();
  return { db, time, repository: new ConversationRepository(db, time.clock) };
}

describe("ConversationRepository", () => {
  test("creates then finds a conversation of the right person", () => {
    const { repository } = createRepository();
    const c = repository.create("kevin", "Volets");
    expect(c.sessionId).toBeNull();
    expect(repository.get(c.id, "kevin")?.title).toBe("Volets");
  });

  test("a conversation starts trusted; the first outside content marks it, for good", () => {
    const { repository, time } = createRepository();
    const c = repository.create("kevin", "Volets");
    expect(c.untrustedAt).toBeNull();
    const first = time.clock();
    repository.markUntrusted(c.id);
    time.advance(60_000);
    repository.markUntrusted(c.id);
    expect(repository.get(c.id, "kevin")?.untrustedAt).toBe(first);
  });

  test("addMessage returns the new message id", () => {
    const { repository } = createRepository();
    const c = repository.create("kevin", "Volets");
    const id = repository.addMessage(c.id, "user", "x");
    expect(repository.messages(c.id)[0]?.id).toBe(id);
  });

  test("deleteMessage removes one message of that conversation only", () => {
    const { repository } = createRepository();
    const c = repository.create("kevin", "Volets");
    const other = repository.create("kevin", "Autre");
    const kept = repository.addMessage(c.id, "user", "garde");
    const dropped = repository.addMessage(c.id, "user", "retire");
    expect(repository.deleteMessage(other.id, dropped)).toBe(false);
    expect(repository.deleteMessage(c.id, dropped)).toBe(true);
    expect(repository.messages(c.id).map((m) => m.id)).toEqual([kept]);
  });

  test("isolation: Élodie does not see Kévin's conversation", () => {
    const { repository } = createRepository();
    const c = repository.create("kevin", "Privé");
    expect(repository.get(c.id, "elodie")).toBeUndefined();
    expect(repository.list("elodie")).toEqual([]);
  });

  test("lists from most to least recent (activity)", () => {
    const { repository, time } = createRepository();
    const a = repository.create("kevin", "A");
    time.advance(1000);
    const b = repository.create("kevin", "B");
    time.advance(1000);
    repository.addMessage(a.id, "user", "relance");
    expect(repository.list("kevin").map((c) => c.id)).toEqual([a.id, b.id]);
  });

  test("on equal activity, the conversation created last comes first", () => {
    const { repository } = createRepository();
    const a = repository.create("kevin", "A");
    const b = repository.create("kevin", "B");
    const c = repository.create("kevin", "C");
    expect(repository.list("kevin").map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });

  test("messages in order, and last messages", () => {
    const { repository } = createRepository();
    const c = repository.create("kevin", "T");
    repository.addMessage(c.id, "user", "1");
    repository.addMessage(c.id, "assistant", "2");
    repository.addMessage(c.id, "user", "3");
    expect(repository.messages(c.id).map((m) => m.text)).toEqual(["1", "2", "3"]);
    expect(repository.lastMessages(c.id, 2).map((m) => m.text)).toEqual(["2", "3"]);
  });

  test("turn log rotation drops entries older than 90 days and keeps the rest", () => {
    const { db, time, repository } = createRepository();
    const DAY = 24 * 3_600_000;
    const c = repository.create("kevin", "T");
    const entry = {
      conversationId: c.id, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1, tools: [], error: null,
    } as const;
    repository.logTurn(entry);
    time.advance(89 * DAY);
    repository.logTurn(entry);
    time.advance(2 * DAY); // the first entry is now 91 days old, the second 2 days old
    expect(repository.purgeTurnLog()).toBe(1);
    expect(db.select().from(turnLog).all()).toHaveLength(1);
    expect(repository.purgeTurnLog()).toBe(0);
  });

  test("stores then clears the SDK session", () => {
    const { repository } = createRepository();
    const c = repository.create("kevin", "T");
    repository.setSession(c.id, "session-1");
    expect(repository.get(c.id, "kevin")?.sessionId).toBe("session-1");
    repository.setSession(c.id, null);
    expect(repository.get(c.id, "kevin")?.sessionId).toBeNull();
  });

  test("logs a turn with its tools as JSON", () => {
    const { db, repository } = createRepository();
    const c = repository.create("kevin", "T");
    repository.logTurn({
      conversationId: c.id, model: "sonnet", inputTokens: 12, outputTokens: 3, durationMs: 800,
      tools: [{ callId: "t1", tool: "weather", success: true }], error: null,
    });
    const row = db.select().from(turnLog).get();
    expect(row?.inputTokens).toBe(12);
    expect(JSON.parse(row?.tools ?? "[]")).toEqual([{ callId: "t1", tool: "weather", success: true }]);
  });

  test("delete removes the conversation, its messages and log; memories stay, unlinked", async () => {
    const { db, time, repository } = createRepository();
    const memory = createTestMemory(db, time.clock);
    const c = repository.create("kevin", "À supprimer");
    const other = repository.create("kevin", "À garder");
    repository.addMessage(c.id, "user", "Bonjour");
    repository.addMessage(c.id, "assistant", "Salut");
    repository.addMessage(other.id, "user", "Reste");
    repository.logTurn({
      conversationId: c.id, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1, tools: [], error: null,
    });
    repository.logTurn({
      conversationId: other.id, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1, tools: [], error: null,
    });
    const remembered = await memory.remember({
      personId: "kevin", scope: "personal", kind: "preference", text: "Kévin adore les lasagnes",
      source: "conversation", conversationId: c.id,
    });
    if (remembered.status !== "created") throw new Error("memory not created");
    expect(memory.get("kevin", remembered.memory.id)?.conversationId).toBe(c.id);

    expect(repository.delete(c.id, "kevin")).toBe(true);

    expect(repository.get(c.id, "kevin")).toBeUndefined();
    expect(repository.messages(c.id)).toEqual([]);
    expect(db.select().from(turnLog).all().map((t) => t.conversationId)).toEqual([other.id]);
    expect(db.select().from(messages).all().map((m) => m.conversationId)).toEqual([other.id]);
    expect(repository.get(other.id, "kevin")).toBeDefined();
    const kept = memory.get("kevin", remembered.memory.id);
    expect(kept?.text).toBe("Kévin adore les lasagnes");
    expect(kept?.conversationId).toBeNull();
  });

  test("delete refuses someone else's conversation", () => {
    const { db, repository } = createRepository();
    const c = repository.create("kevin", "Privé");
    repository.addMessage(c.id, "user", "secret");
    repository.logTurn({
      conversationId: c.id, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1, tools: [], error: null,
    });
    expect(repository.delete(c.id, "elodie")).toBe(false);
    expect(repository.get(c.id, "kevin")).toBeDefined();
    expect(repository.messages(c.id)).toHaveLength(1);
    expect(db.select().from(turnLog).all()).toHaveLength(1);
    expect(repository.delete("unknown", "kevin")).toBe(false);
  });
});
