import type { Person, SendMessage, ServerEvent } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { buildResumePrompt, type ChatDependencies, handleSend, titleFrom, type TurnPorts } from "../src/conversations/chat-service.ts";
import type { Message } from "../src/conversations/repository.ts";
import { turnLog } from "../src/db/schema.ts";
import { type Engine, INCOMPLETE_TURN_MESSAGE } from "../src/engine/engine.ts";
import { callTool, FakeEngine, type Scenario } from "../src/engine/fake-engine.ts";
import { answeringPorts, createChatDeps, createTestClock, createTestDb, ELODIE, KEVIN } from "./helpers.ts";

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
  const engine = new FakeEngine(...scenarios);
  const deps = createChatDeps(db, time.clock, engine);
  return { db, deps, engine, repository: deps.repository, memory: deps.memory };
}

async function send(
  deps: ChatDependencies,
  person: Person,
  message: Omit<SendMessage, "type" | "requestId">,
  ports: TurnPorts = answeringPorts("approved").ports,
) {
  const output: ServerEvent[] = [];
  const full: SendMessage = { type: "send", requestId: REQUEST_ID, ...message };
  for await (const e of handleSend(deps, person, full, new AbortController().signal, ports)) output.push(e);
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
      () => [{ type: "error", code: "unreadable_session", message: "La session précédente est illisible." }],
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

  test("a network failure on a resumed session: no retry, the session is kept", async () => {
    const { deps, repository, engine } = createContext(
      SIMPLE_REPLY,
      () => [{ type: "error", code: "engine", message: "Le moteur a échoué : fetch failed" }],
      SIMPLE_REPLY,
    );
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    const events = await send(deps, KEVIN, { text: "Deux", conversationId: id });
    expect(engine.requests).toHaveLength(2);
    expect(repository.get(id, "kevin")?.sessionId).toBe("s1");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "engine", message: "Le moteur a échoué : fetch failed" });
  });

  test("an unreadable session that cannot be retried reaches the app as an engine error", async () => {
    const unreadable: Scenario = () => [
      { type: "error", code: "unreadable_session", message: "La session précédente est illisible." },
    ];
    const { deps, engine } = createContext(SIMPLE_REPLY, unreadable, unreadable);
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    const events = await send(deps, KEVIN, { text: "Deux", conversationId: id });
    expect(engine.requests).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "engine" });
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

  test("an engine that stops without done nor error: engine error, partial text kept, no retry", async () => {
    const { deps, repository, engine, db } = createContext(() => [
      { type: "session", sessionId: "s1" },
      { type: "text", text: "Il fait" },
    ]);
    const events = await send(deps, KEVIN, { text: "Quelle température ?" });
    const id = events[0]?.type === "conversation" ? events[0].conversationId : "";
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "error", requestId: REQUEST_ID, conversationId: id, code: "engine", message: INCOMPLETE_TURN_MESSAGE,
    });
    expect(engine.requests).toHaveLength(1);
    expect(repository.messages(id).map((m) => [m.role, m.text])).toEqual([
      ["user", "Quelle température ?"],
      ["assistant", "Il fait"],
    ]);
    expect(db.select().from(turnLog).all().map((j) => j.error)).toEqual([INCOMPLETE_TURN_MESSAGE]);
  });

  test("relays tool calls", async () => {
    const { deps } = createContext(() => [
      { type: "tool_call", callId: "t1", tool: "weather" },
      { type: "tool_result", callId: "t1", success: true },
      { type: "text", text: "Beau temps." },
      { type: "done", inputTokens: 1, outputTokens: 1 },
    ]);
    const events = await send(deps, KEVIN, { text: "Météo ?" });
    expect(events.map((e) => e.type)).toEqual(["conversation", "tool_call", "tool_result", "text_delta", "done"]);
    expect(events[1]).toMatchObject({ type: "tool_call", tool: "weather", label: "Alicia utilise l'outil « weather »…" });
  });

  test("a tool call carries the label of the turn's tool", async () => {
    const { deps } = createContext(() => [
      { type: "tool_call", callId: "t1", tool: "memory_remember" },
      { type: "done", inputTokens: 1, outputTokens: 1 },
    ]);
    const events = await send(deps, KEVIN, { text: "Retiens ça" });
    expect(events[1]).toMatchObject({ type: "tool_call", label: "Alicia retient ça…" });
  });

  test("cancellation: no retry, session kept, no \"done\", turn logged as « annulé »", async () => {
    const fake = new FakeEngine(SIMPLE_REPLY, () => [{ type: "error", code: "engine", message: "interrompu" }]);
    // An engine that ignores the signal, like a process dying while being cancelled.
    const engine: Engine = { run: (request) => fake.run(request) };
    const db = createTestDb();
    const deps = createChatDeps(db, createTestClock().clock, engine);
    const { repository } = deps;
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";

    const cancelled = new AbortController();
    cancelled.abort();
    const output: ServerEvent[] = [];
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Deux", conversationId: id };
    for await (const e of handleSend(deps, KEVIN, full, cancelled.signal, answeringPorts("approved").ports)) output.push(e);

    expect(fake.requests).toHaveLength(2);
    expect(repository.get(id, "kevin")?.sessionId).toBe("s1");
    expect(output.some((e) => e.type === "done" || e.type === "error")).toBe(false);
    expect(db.select().from(turnLog).all().map((j) => j.error)).toEqual([null, "annulé"]);
  });

  test("cancelling a turn that succeeds on the engine side: no \"done\"", async () => {
    const fake = new FakeEngine(SIMPLE_REPLY);
    const engine: Engine = { run: (request) => fake.run(request) };
    const time = createTestClock();
    const deps = createChatDeps(createTestDb(), time.clock, engine);
    const cancelled = new AbortController();
    cancelled.abort();
    const output: ServerEvent[] = [];
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Un" };
    for await (const e of handleSend(deps, KEVIN, full, cancelled.signal, answeringPorts("approved").ports)) {
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
      for await (const e of handleSend(deps, KEVIN, full, new AbortController().signal, answeringPorts("approved").ports)) output.push(e);
    }).rejects.toThrow("disk full");
    expect(output.some((e) => e.type === "error")).toBe(false);
    expect(engine.requests).toHaveLength(1);
  });

  test("the consumer stops early: the partial text and the turn log are still stored", async () => {
    const { deps, repository, db } = createContext(SIMPLE_REPLY);
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Salut" };
    let id = "";
    for await (const e of handleSend(deps, KEVIN, full, new AbortController().signal, answeringPorts("approved").ports)) {
      if (e.type === "conversation") id = e.conversationId;
      if (e.type === "text_delta") break;
    }
    expect(repository.messages(id).map((m) => [m.role, m.text])).toEqual([
      ["user", "Salut"],
      ["assistant", "Il fait "],
    ]);
    expect(db.select().from(turnLog).all()).toHaveLength(1);
  });

  test("the consumer stops at the very first event of a new conversation: the empty conversation is dropped", async () => {
    const { deps, repository, engine } = createContext(SIMPLE_REPLY);
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Salut" };
    for await (const e of handleSend(deps, KEVIN, full, new AbortController().signal, answeringPorts("approved").ports)) {
      if (e.type === "conversation") break;
    }
    expect(repository.list("kevin")).toEqual([]);
    expect(engine.requests).toHaveLength(0);
  });

  test("the consumer stops at the first event of an existing conversation: the conversation stays", async () => {
    const { deps, repository } = createContext(SIMPLE_REPLY);
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Deux", conversationId: id };
    for await (const e of handleSend(deps, KEVIN, full, new AbortController().signal, answeringPorts("approved").ports)) {
      if (e.type === "conversation") break;
    }
    expect(repository.list("kevin").map((c) => c.id)).toEqual([id]);
    expect(repository.messages(id)).toHaveLength(2);
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

  test("the engine receives the memory tools and the sheet", async () => {
    const { deps, engine } = createContext(SIMPLE_REPLY);
    await deps.memory.remember({ personId: "kevin", scope: "common", kind: "rule", text: "Pas plus de 20 °C", source: "manual" });
    await send(deps, KEVIN, { text: "Salut" });
    expect(engine.requests[0]?.tools.map((t) => t.name)).toEqual(["memory_search", "memory_remember", "memory_update", "memory_forget"]);
    expect(engine.requests[0]?.systemPrompt).toContain("Pas plus de 20 °C");
  });

  test("a memory remembered during a turn is linked to the conversation", async () => {
    const { deps } = createContext(async (request) => {
      await callTool(request, "memory_remember", { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" });
      return [{ type: "text", text: "Noté !" }, { type: "done", inputTokens: 1, outputTokens: 1 }];
    });
    const events = await send(deps, KEVIN, { text: "Retiens que j'adore les lasagnes" });
    const conversationId = events[0]?.type === "conversation" ? events[0].conversationId : "";
    expect(deps.memory.list("kevin", {})[0]?.conversationId).toBe(conversationId);
  });

  test("a confirmation is asked through the ports, for the turn's conversation", async () => {
    let memoryId = "";
    const { deps, memory } = createContext(async (request) => {
      const result = await callTool(request, "memory_forget", { id: memoryId });
      return [{ type: "text", text: result.isError === true ? "Je le garde." : "Oublié." }, { type: "done", inputTokens: 1, outputTokens: 1 }];
    });
    const saved = await memory.remember({ personId: "kevin", scope: "personal", kind: "fact", text: "Kévin court le dimanche", source: "manual" });
    if (saved.status !== "created") throw new Error("not created");
    memoryId = saved.memory.id;
    const seen: string[] = [];
    const ports: TurnPorts = {
      confirm: (conversationId, request) => {
        seen.push(`${conversationId}:${request.tool}`);
        return Promise.resolve("refused");
      },
    };
    const events = await send(deps, KEVIN, { text: "Oublie que je cours" }, ports);
    const first = events[0];
    if (first?.type !== "conversation") throw new Error("expected a conversation event first");
    expect(seen).toEqual([`${first.conversationId}:memory_forget`]);
    expect(events).toContainEqual({ type: "text_delta", conversationId: first.conversationId, text: "Je le garde." });
    expect(memory.get("kevin", memoryId)).toBeDefined();
  });

  test("the turn's signal reaches the confirmation", async () => {
    let memoryId = "";
    const { deps, memory } = createContext(async (request) => {
      await callTool(request, "memory_forget", { id: memoryId });
      return [{ type: "done", inputTokens: 1, outputTokens: 1 }];
    });
    const saved = await memory.remember({ personId: "kevin", scope: "personal", kind: "fact", text: "Kévin court le dimanche", source: "manual" });
    if (saved.status !== "created") throw new Error("not created");
    memoryId = saved.memory.id;
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const ports: TurnPorts = {
      confirm: (_conversationId, _request, signal) => {
        received = signal;
        return Promise.resolve("approved");
      },
    };
    const full: SendMessage = { type: "send", requestId: REQUEST_ID, text: "Oublie que je cours" };
    const output: ServerEvent[] = [];
    for await (const e of handleSend(deps, KEVIN, full, controller.signal, ports)) output.push(e);
    expect(output.at(-1)?.type).toBe("done");
    expect(received).toBe(controller.signal);
    expect(memory.get("kevin", memoryId)).toBeUndefined();
  });
});

describe("buildResumePrompt", () => {
  const message = (i: number, text: string): Message => ({
    id: `m${i}`, conversationId: "c", role: i % 2 === 0 ? "user" : "assistant", text, createdAt: i,
  });

  test("no history: the prompt alone", () => {
    expect(buildResumePrompt([], "Bonjour")).toBe("Bonjour");
  });

  test("long messages are cut and the most recent ones are kept within the budget", () => {
    const history = Array.from({ length: 10 }, (_, i) => message(i, `${i}:${"x".repeat(1_500)}`));
    const prompt = buildResumePrompt(history, "Nouveau");
    // Each line is cut to 1,000 characters of text: messages 9 to 3 fit in the budget, 2 no longer does.
    expect(prompt).toContain("Alicia : 9:");
    expect(prompt).toContain("Alicia : 3:");
    expect(prompt).not.toContain("Utilisateur : 2:");
    expect(prompt).toContain(`Alicia : 9:${"x".repeat(997)}…\n`);
    expect(prompt.endsWith("Nouveau message :\nNouveau")).toBe(true);
  });

  test("the context is capped at 8,000 characters, header and line breaks included", () => {
    // Eight lines of exactly 1,000 characters: 8,000 without the header and the line breaks.
    const history = Array.from({ length: 8 }, (_, i) =>
      message(i, `${i}:${"y".repeat((i % 2 === 0 ? 986 : 991) - 2)}`),
    );
    const prompt = buildResumePrompt(history, "Nouveau");
    const context = prompt.slice(0, prompt.indexOf("\n\nNouveau message :"));
    expect(context.length).toBeLessThanOrEqual(8_000);
    expect(prompt).toContain("Alicia : 7:");
    expect(prompt).not.toContain("Utilisateur : 0:");
  });

  test("a cut never splits an emoji in two", () => {
    const prompt = buildResumePrompt([message(1, `${"a".repeat(998)}😀b`)], "Nouveau");
    expect(prompt.isWellFormed()).toBe(true);
    expect(prompt).toContain(`Alicia : ${"a".repeat(998)}…\n`);
  });
});

describe("titleFrom", () => {
  test("first line, trimmed, cut to 60 characters", () => {
    expect(titleFrom("  Volets du salon  \net le reste")).toBe("Volets du salon");
    expect(titleFrom("x".repeat(70))).toBe(`${"x".repeat(59)}…`);
  });

  test("a cut never splits an emoji in two", () => {
    const title = titleFrom(`${"a".repeat(58)}😀 et la suite`);
    expect(title.isWellFormed()).toBe(true);
    expect(title).toBe(`${"a".repeat(58)}…`);
  });
});
