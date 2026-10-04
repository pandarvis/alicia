import { describe, expect, test } from "vitest";
import { turnLog } from "../src/db/schema.ts";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { createTestClock, createTestDb } from "./helpers.ts";

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
});
