import type { Person, SendMessage, ServerEvent } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { handleSend } from "../src/conversations/chat-service.ts";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { turnLog } from "../src/db/schema.ts";
import type { Engine } from "../src/engine/engine.ts";
import { FakeEngine, type Scenario } from "../src/engine/fake-engine.ts";
import { createTestClock, createTestDb, ELODIE, KEVIN } from "./helpers.ts";

const REQUEST_ID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

const SIMPLE_REPLY: Scenario = () => [
  { type: "session", sessionId: "s1" },
  { type: "text", text: "Il fait " },
  { type: "text", text: "19 °C." },
  { type: "done", inputTokens: 100, outputTokens: 8 },
];

function createContext(...scenarios: Scenario[]) {
  const db = createTestDb();
  const time = createTestClock();
  const repository = new ConversationRepository(db, time.clock);
  const engine = new FakeEngine(...scenarios);
  return { db, repository, engine, deps: { repository, engine, clock: time.clock, timezone: "Europe/Paris" } };
}

async function send(
  deps: Parameters<typeof handleSend>[0], person: Person, message: Omit<SendMessage, "type" | "requestId">,
) {
  const output: ServerEvent[] = [];
  const full: SendMessage = { type: "send", requestId: REQUEST_ID, ...message };
  for await (const e of handleSend(deps, person, full, new AbortController().signal)) output.push(e);
  return output;
}

describe("handleSend", () => {
  test("new conversation: events, history, session and turn log", async () => {
    const { deps, repository, engine } = createContext(SIMPLE_REPLY);
    const events = await send(deps, KEVIN, { text: "Quelle température ?" });

    const first = events[0];
    if (first?.type !== "conversation") throw new Error("expected a conversation event first");
    const id = first.conversationId;
    expect(events.slice(1)).toEqual([
      { type: "text_delta", conversationId: id, text: "Il fait " },
      { type: "text_delta", conversationId: id, text: "19 °C." },
      { type: "done", conversationId: id, model: "sonnet", inputTokens: 100, outputTokens: 8, durationMs: 0 },
    ]);
    expect(repository.messages(id).map((m) => [m.role, m.text])).toEqual([
      ["user", "Quelle température ?"],
      ["assistant", "Il fait 19 °C."],
    ]);
    expect(repository.get(id, "kevin")?.sessionId).toBe("s1");
    expect(repository.get(id, "kevin")?.title).toBe("Quelle température ?");
    expect(engine.requests[0]?.prompt).toMatch(/^\[dimanche 4 octobre 2026.*\]\nQuelle température \?$/);
    expect(engine.requests[0]?.systemPrompt).toContain("Tu parles avec Kévin.");
  });

  test("existing conversation: resumes the SDK session", async () => {
    const { deps, engine } = createContext(SIMPLE_REPLY);
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    await send(deps, KEVIN, { text: "Deux", conversationId: id });
    expect(engine.requests[1]?.sessionId).toBe("s1");
  });

  test("isolation: Élodie cannot write in Kévin's conversation", async () => {
    const { deps, engine } = createContext(SIMPLE_REPLY);
    const firsts = await send(deps, KEVIN, { text: "Secret" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    const events = await send(deps, ELODIE, { text: "Lis ça", conversationId: id });
    expect(events).toEqual([
      { type: "error", requestId: REQUEST_ID, code: "invalid_request", message: "Conversation introuvable." },
    ]);
    expect(engine.requests).toHaveLength(1);
  });

  test("« réfléchis bien » switches to Opus", async () => {
    const { deps, engine } = createContext(SIMPLE_REPLY);
    await send(deps, KEVIN, { text: "Réfléchis bien au menu" });
    expect(engine.requests[0]?.model).toBe("opus");
  });

  test("unreadable session: a single retry, without a session, primed with the history", async () => {
    const { deps, repository, engine } = createContext(
      SIMPLE_REPLY,
      () => [{ type: "error", code: "engine", message: "session introuvable" }],
      SIMPLE_REPLY,
    );
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    const events = await send(deps, KEVIN, { text: "Deux", conversationId: id });

    expect(engine.requests).toHaveLength(3);
    expect(engine.requests[1]?.sessionId).toBe("s1");
    expect(engine.requests[2]?.sessionId).toBeUndefined();
    expect(engine.requests[2]?.prompt).toContain("Utilisateur : Un");
    expect(engine.requests[2]?.prompt).toContain("Alicia : Il fait 19 °C.");
    expect(events.at(-1)?.type).toBe("done");
    expect(repository.get(id, "kevin")?.sessionId).toBe("s1");
  });

  test("quota reached: error relayed, nothing made up, turn logged", async () => {
    const { deps, repository } = createContext(() => [
      { type: "error", code: "quota", message: "Je me repose : le quota de l'abonnement est atteint." },
    ]);
    const events = await send(deps, KEVIN, { text: "Salut" });
    const id = events[0]?.type === "conversation" ? events[0].conversationId : "";
    expect(events.at(-1)).toEqual({
      type: "error", requestId: REQUEST_ID, conversationId: id, code: "quota",
      message: "Je me repose : le quota de l'abonnement est atteint.",
    });
    expect(repository.messages(id).map((m) => m.role)).toEqual(["user"]);
  });

  test("an engine that throws becomes an \"engine\" error", async () => {
    const { deps } = createContext(() => {
      throw new Error("process died");
    });
    const events = await send(deps, KEVIN, { text: "Salut" });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "engine" });
  });

  test("relays tool calls", async () => {
    const { deps } = createContext(() => [
      { type: "tool_call", callId: "t1", tool: "weather" },
      { type: "tool_result", callId: "t1", success: true },
      { type: "text", text: "Beau temps." },
      { type: "done", inputTokens: 1, outputTokens: 1 },
    ]);
    const types = (await send(deps, KEVIN, { text: "Météo ?" })).map((e) => e.type);
    expect(types).toEqual(["conversation", "tool_call", "tool_result", "text_delta", "done"]);
  });

  test("cancellation: no retry, session kept, no \"done\", turn logged as « annulé »", async () => {
    const fake = new FakeEngine(SIMPLE_REPLY, () => [{ type: "error", code: "engine", message: "interrompu" }]);
    // An engine that ignores the signal, like a process dying while being cancelled.
    const engine: Engine = { run: (request) => fake.run(request) };
    const db = createTestDb();
    const repository = new ConversationRepository(db, createTestClock().clock);
    const deps = { repository, engine, clock: createTestClock().clock, timezone: "Europe/Paris" };
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";

    const cancelled = new AbortController();
    cancelled.abort();
    const output: ServerEvent[] = [];
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Deux", conversationId: id };
    for await (const e of handleSend(deps, KEVIN, full, cancelled.signal)) output.push(e);

    expect(fake.requests).toHaveLength(2);
    expect(repository.get(id, "kevin")?.sessionId).toBe("s1");
    expect(output.some((e) => e.type === "done" || e.type === "error")).toBe(false);
    expect(db.select().from(turnLog).all().map((j) => j.error)).toEqual([null, "annulé"]);
  });

  test("cancelling a turn that succeeds on the engine side: no \"done\"", async () => {
    const fake = new FakeEngine(SIMPLE_REPLY);
    const engine: Engine = { run: (request) => fake.run(request) };
    const time = createTestClock();
    const repository = new ConversationRepository(createTestDb(), time.clock);
    const cancelled = new AbortController();
    cancelled.abort();
    const output: ServerEvent[] = [];
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Un" };
    for await (const e of handleSend({ repository, engine, clock: time.clock, timezone: "Europe/Paris" }, KEVIN, full, cancelled.signal)) {
      output.push(e);
    }
    expect(output.some((e) => e.type === "done")).toBe(false);
  });

  test("no retry after a tool call", async () => {
    const { deps, engine } = createContext(
      SIMPLE_REPLY,
      () => [
        { type: "tool_call", callId: "t1", tool: "weather" },
        { type: "error", code: "engine", message: "plantage" },
      ],
      SIMPLE_REPLY,
    );
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    const events = await send(deps, KEVIN, { text: "Deux", conversationId: id });
    expect(engine.requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "engine", message: "plantage" });
  });

  test("a repository failure is not an engine error: it propagates, without retry", async () => {
    const { deps, repository, engine } = createContext(SIMPLE_REPLY, SIMPLE_REPLY);
    vi.spyOn(repository, "setSession").mockImplementation(() => {
      throw new Error("disk full");
    });
    const output: ServerEvent[] = [];
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Un" };
    await expect(async () => {
      for await (const e of handleSend(deps, KEVIN, full, new AbortController().signal)) output.push(e);
    }).rejects.toThrow("disk full");
    expect(output.some((e) => e.type === "error")).toBe(false);
    expect(engine.requests).toHaveLength(1);
  });

  test("the consumer stops early: the partial text and the turn log are still stored", async () => {
    const { deps, repository, db } = createContext(SIMPLE_REPLY);
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Salut" };
    let id = "";
    for await (const e of handleSend(deps, KEVIN, full, new AbortController().signal)) {
      if (e.type === "conversation") id = e.conversationId;
      if (e.type === "text_delta") break;
    }
    expect(repository.messages(id).map((m) => [m.role, m.text])).toEqual([
      ["user", "Salut"],
      ["assistant", "Il fait "],
    ]);
    expect(db.select().from(turnLog).all()).toHaveLength(1);
  });

  test("session lost on an existing conversation: the context is re-injected", async () => {
    const { deps, repository, engine } = createContext(SIMPLE_REPLY);
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    repository.setSession(id, null);
    await send(deps, KEVIN, { text: "Deux", conversationId: id });
    expect(engine.requests[1]?.sessionId).toBeUndefined();
    expect(engine.requests[1]?.prompt).toContain("Utilisateur : Un");
    expect(engine.requests[1]?.prompt).toContain("Alicia : Il fait 19 °C.");
  });
});
