import type { ConversationSummary, HistoryMessage, SendMessage } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { ChatStore, type ChatPorts } from "../src/renderer/src/lib/chat-store.svelte.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const CONV_B = "7a9d0c3e-1b2f-4e5a-8c6d-9e0f1a2b3c4d";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function msg(id: string, text: string): HistoryMessage {
  return { id, role: "user", text, createdAt: "2026-10-04T13:30:00.000Z" };
}

function setup(history: HistoryMessage[] = [], overrides: Partial<ChatPorts> = {}) {
  let counter = 0;
  const sent: SendMessage[] = [];
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  let conversations: ConversationSummary[] = [];
  const store = new ChatStore({
    listConversations: () => Promise.resolve(conversations),
    history: () => Promise.resolve(history),
    send: (m) => {
      sent.push(m);
      return true;
    },
    deleteConversation: () => Promise.resolve("deleted"),
    newId: () => `00000000-0000-4000-8000-00000000000${counter++}`,
    schedule: (run, ms) => {
      const t = { run, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    ...overrides,
  });
  return {
    store, sent, timers,
    setConversations: (list: ConversationSummary[]) => {
      conversations = list;
    },
  };
}

describe("ChatStore", () => {
  test("starts idle and empty", () => {
    const { store } = setup();
    expect(store.messages).toEqual([]);
    expect(store.mascot).toBe("idle");
    expect(store.busy).toBe(false);
  });

  test("send: user bubble, request without conversation id, mascot thinking", () => {
    const { store, sent } = setup();
    expect(store.send("Salut")).toBe(true);
    expect(store.messages.map((m) => [m.role, m.text])).toEqual([["user", "Salut"]]);
    expect(sent[0]).toEqual({ type: "send", requestId: sent[0]?.requestId, text: "Salut" });
    expect(store.busy).toBe(true);
    expect(store.mascot).toBe("thinking");
  });

  test("blank text or a turn in progress: nothing sent", () => {
    const { store, sent } = setup();
    expect(store.send("   ")).toBe(false);
    store.send("Un");
    expect(store.send("Deux")).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("Opus toggle adds the model", () => {
    const { store, sent } = setup();
    store.opus = true;
    store.send("Réfléchis");
    expect(sent[0]?.model).toBe("opus");
  });

  test("« Réfléchir » applies to one message only", () => {
    const { store, sent } = setup();
    store.opus = true;
    store.send("Une question difficile");
    expect(store.opus).toBe(false);
    expect(sent[0]?.model).toBe("opus");
  });

  test("« Réfléchir » stays on if the message could not be sent", () => {
    const { store } = setup();
    store.opus = true;
    expect(store.send("   ")).toBe(false);
    expect(store.opus).toBe(true);
  });

  test("full turn: conversation id, streamed text, done → success then idle", async () => {
    const { store, sent, timers, setConversations } = setup();
    store.send("Salut");
    const requestId = sent[0]?.requestId ?? "";
    setConversations([{ id: CONV, title: "Salut", updatedAt: "2026-10-04T13:30:00.000Z" }]);
    store.handle({ type: "conversation", requestId, conversationId: CONV });
    expect(store.activeId).toBe(CONV);
    store.handle({ type: "text_delta", conversationId: CONV, text: "Bon" });
    expect(store.mascot).toBe("speaking");
    store.handle({ type: "text_delta", conversationId: CONV, text: "jour !" });
    expect(store.messages.at(-1)).toMatchObject({ role: "assistant", text: "Bonjour !", streaming: true });
    store.handle({
      type: "done", conversationId: CONV, model: "sonnet", inputTokens: 1, outputTokens: 2, durationMs: 3,
    });
    expect(store.messages.at(-1)?.streaming).toBe(false);
    expect(store.busy).toBe(false);
    expect(store.mascot).toBe("success");
    timers.at(-1)?.run();
    expect(store.mascot).toBe("idle");
    await vi.waitFor(() => {
      expect(store.conversations.map((c) => c.id)).toEqual([CONV]);
    });
  });

  test("next message continues the same conversation", () => {
    const { store, sent } = setup();
    store.send("Un");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({
      type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0,
    });
    store.send("Deux");
    expect(sent[1]?.conversationId).toBe(CONV);
  });

  test("tool call shows an activity line, cleared by the text", () => {
    const { store, sent } = setup();
    store.send("Météo ?");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool: "weather" });
    expect(store.activity).toBe("Alicia utilise l'outil « weather »…");
    expect(store.mascot).toBe("thinking");
    store.handle({ type: "text_delta", conversationId: CONV, text: "Beau temps." });
    expect(store.activity).toBeNull();
  });

  test.each([
    ["memory_search", "Alicia fouille dans sa mémoire…"],
    ["memory_remember", "Alicia retient ça…"],
    ["memory_update", "Alicia met sa mémoire à jour…"],
    ["memory_forget", "Alicia oublie ce souvenir…"],
    ["weather", "Alicia utilise l'outil « weather »…"],
  ])("tool %s → activity label", (tool, label) => {
    const { store, sent } = setup();
    store.send("x");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool });
    expect(store.activity).toBe(label);
  });

  test("remembering gives the mascot an idea, other tools keep it thinking", () => {
    const { store, sent } = setup();
    store.send("Retiens ça");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool: "memory_remember" });
    expect(store.mascot).toBe("idea");
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t2", tool: "memory_search" });
    expect(store.mascot).toBe("thinking");
  });

  test.each([
    ["quota", "sleeping"],
    ["engine", "error"],
    ["internal", "error"],
    ["busy", "alert"],
  ] as const)("error %s → notice and mascot %s", (code, mascot) => {
    const { store, sent } = setup();
    store.send("Salut");
    store.handle({ type: "error", requestId: sent[0]?.requestId ?? "", code, message: "Message du cerveau." });
    expect(store.notice).toBe("Message du cerveau.");
    expect(store.busy).toBe(false);
    expect(store.mascot).toBe(mascot);
  });

  test("connection lost mid-turn ends the turn with a notice", () => {
    const { store } = setup();
    store.send("Salut");
    store.connectionLost();
    expect(store.busy).toBe(false);
    expect(store.notice).toBe("Connexion perdue : la réponse d'Alicia n'est pas arrivée.");
    expect(store.mascot).toBe("alert");
  });

  test("open loads the history; startNew clears it", async () => {
    const { store } = setup([
      { id: "a", role: "user", text: "Salut", createdAt: "2026-10-04T13:30:00.000Z" },
      { id: "b", role: "assistant", text: "Coucou !", createdAt: "2026-10-04T13:30:01.000Z" },
    ]);
    await store.open(CONV);
    expect(store.activeId).toBe(CONV);
    expect(store.messages.map((m) => m.text)).toEqual(["Salut", "Coucou !"]);
    store.startNew();
    expect(store.activeId).toBeNull();
    expect(store.messages).toEqual([]);
  });

  test("send during a pending open is refused", async () => {
    const d = deferred<HistoryMessage[]>();
    const { store, sent } = setup([], { history: () => d.promise });
    const opening = store.open(CONV);
    expect(store.loading).toBe(true);
    expect(store.send("Salut")).toBe(false);
    expect(sent).toHaveLength(0);
    d.resolve([msg("a", "Hello")]);
    await opening;
    expect(store.loading).toBe(false);
    expect(store.send("Salut")).toBe(true);
  });

  test("open clears the previous messages right away", async () => {
    const d = deferred<HistoryMessage[]>();
    const { store } = setup([], { history: () => d.promise });
    store.messages = [{ id: "x", role: "user", text: "Ancien", streaming: false }];
    const opening = store.open(CONV);
    expect(store.messages).toEqual([]);
    d.resolve([]);
    await opening;
  });

  test("overlapping opens: only the latest one is shown", async () => {
    const first = deferred<HistoryMessage[]>();
    const second = deferred<HistoryMessage[]>();
    const { store } = setup([], { history: (id) => (id === CONV ? first.promise : second.promise) });
    const a = store.open(CONV);
    const b = store.open(CONV_B);
    second.resolve([msg("b", "Deuxième")]);
    await b;
    first.resolve([msg("a", "Première")]);
    await a;
    expect(store.activeId).toBe(CONV_B);
    expect(store.messages.map((m) => m.text)).toEqual(["Deuxième"]);
    expect(store.loading).toBe(false);
  });

  test("a failing stale open does not set a notice", async () => {
    const first = deferred<HistoryMessage[]>();
    const second = deferred<HistoryMessage[]>();
    const { store } = setup([], { history: (id) => (id === CONV ? first.promise : second.promise) });
    const a = store.open(CONV);
    const b = store.open(CONV_B);
    second.resolve([msg("b", "Deuxième")]);
    await b;
    first.reject(new Error("boom"));
    await a;
    expect(store.notice).toBeNull();
    expect(store.messages.map((m) => m.text)).toEqual(["Deuxième"]);
  });

  test("a failing open sets a notice and ends loading", async () => {
    const { store } = setup([], { history: () => Promise.reject(new Error("boom")) });
    await store.open(CONV);
    expect(store.notice).toBe("Impossible de charger cette conversation pour l'instant.");
    expect(store.loading).toBe(false);
  });

  test("startNew cancels a pending open", async () => {
    const d = deferred<HistoryMessage[]>();
    const { store } = setup([], { history: () => d.promise });
    const opening = store.open(CONV);
    store.startNew();
    d.resolve([msg("a", "Tard")]);
    await opening;
    expect(store.activeId).toBeNull();
    expect(store.messages).toEqual([]);
    expect(store.loading).toBe(false);
  });

  test("late events after connectionLost are ignored", () => {
    const { store } = setup();
    store.send("Salut");
    store.connectionLost();
    const count = store.messages.length;
    store.handle({ type: "text_delta", conversationId: CONV, text: "Tard" });
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t", tool: "weather" });
    store.handle({
      type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0,
    });
    expect(store.messages).toHaveLength(count);
    expect(store.activity).toBeNull();
    expect(store.mascot).toBe("alert");
  });

  test("undelivered: the pending message ends the turn with a notice", () => {
    const { store, sent } = setup();
    store.send("Salut");
    store.undelivered("00000000-0000-4000-8000-000000000099");
    expect(store.busy).toBe(true);
    store.undelivered(sent[0]?.requestId ?? "");
    expect(store.busy).toBe(false);
    expect(store.notice).toBe("Alicia n'est pas joignable pour l'instant.");
    expect(store.mascot).toBe("alert");
  });

  test("another window's turn ending refreshes the list and reloads the open conversation", async () => {
    const history = vi.fn(() => Promise.resolve([msg("00000000-0000-4000-8000-0000000000a1", "Avant")]));
    const listConversations = vi.fn(() => Promise.resolve([]));
    const { store } = setup([], { history, listConversations });
    await store.open(CONV);
    expect(history).toHaveBeenCalledTimes(1);
    store.handle({ type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    await vi.waitFor(() => { expect(history).toHaveBeenCalledTimes(2); });
    expect(listConversations).toHaveBeenCalled();
    store.handle({ type: "done", conversationId: CONV_B, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    expect(history).toHaveBeenCalledTimes(2);
  });

  test("a conversation asked from outside (notification) while Alicia answers here opens once the turn ends", async () => {
    const history = vi.fn(() => Promise.resolve([msg("00000000-0000-4000-8000-0000000000a1", "Avant")]));
    const { store, sent } = setup([], { history });
    store.openWhenIdle(CONV_B);
    await vi.waitFor(() => { expect(store.activeId).toBe(CONV_B); });
    store.startNew();
    store.send("Question");
    store.openWhenIdle(CONV);
    expect(store.activeId).toBeNull();
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV_B });
    store.handle({ type: "done", conversationId: CONV_B, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    await vi.waitFor(() => { expect(store.activeId).toBe(CONV); });
    expect(history).toHaveBeenLastCalledWith(CONV);
  });

  test("another window's answer ending in the open conversation never ends this window's own pending turn", async () => {
    const { store, sent } = setup();
    await store.open(CONV);
    // This window asks in CONV while the Holo's turn in CONV is finishing: the Holo's `done` lands first.
    store.send("Et maintenant ?");
    store.handle({ type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    expect(store.busy).toBe(true);
    // Then the brain refuses this window's message (the conversation was still locked): it is said.
    store.handle({ type: "error", requestId: sent[0]?.requestId ?? "", code: "busy", message: "Alicia répond déjà dans cette conversation." });
    expect(store.busy).toBe(false);
    expect(store.notice).toBe("Alicia répond déjà dans cette conversation.");
  });

  test("a new conversation started while another window's answer streams never shows that answer", () => {
    const { store, sent } = setup();
    store.send("Nouvelle question");
    // The Holo's turn in another conversation, before this window's own conversation is known.
    store.handle({ type: "text_delta", conversationId: CONV_B, text: "Intrus" });
    store.handle({ type: "tool_call", conversationId: CONV_B, callId: "t", tool: "weather" });
    store.handle({ type: "done", conversationId: CONV_B, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    expect(store.messages.map((m) => m.text)).toEqual(["Nouvelle question"]);
    expect([store.busy, store.activity]).toEqual([true, null]);
    // Its own conversation arrives: from now on, its events count.
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "text_delta", conversationId: CONV_B, text: "Encore" });
    store.handle({ type: "text_delta", conversationId: CONV, text: "Réponse" });
    store.handle({ type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    expect(store.messages.map((m) => m.text)).toEqual(["Nouvelle question", "Réponse"]);
    expect(store.busy).toBe(false);
  });

  test("events for another conversation are ignored while busy", () => {
    const { store, sent } = setup();
    store.send("Un");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "text_delta", conversationId: CONV_B, text: "Intrus" });
    store.handle({
      type: "done", conversationId: CONV_B, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0,
    });
    expect(store.messages.map((m) => m.text)).toEqual(["Un"]);
    expect(store.busy).toBe(true);
  });

  test("overlapping refreshes: an older response never overwrites a newer one", async () => {
    const first = deferred<ConversationSummary[]>();
    const second = deferred<ConversationSummary[]>();
    const queue = [first, second];
    const { store } = setup([], { listConversations: () => queue.shift()?.promise ?? Promise.resolve([]) });
    const a = store.refreshConversations();
    const b = store.refreshConversations();
    second.resolve([{ id: CONV_B, title: "Récent", updatedAt: "2026-10-04T14:00:00.000Z" }]);
    await b;
    first.resolve([{ id: CONV, title: "Ancien", updatedAt: "2026-10-04T13:00:00.000Z" }]);
    await a;
    expect(store.conversations.map((c) => c.id)).toEqual([CONV_B]);
  });

  test("resync re-fetches the active history after a lost turn", async () => {
    const history = vi.fn<ChatPorts["history"]>(() => Promise.resolve([msg("a", "Salut")]));
    const { store, sent } = setup([], { history });
    store.send("Salut");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.connectionLost();
    history.mockResolvedValue([msg("a", "Salut"), { ...msg("b", "Fini !"), role: "assistant" }]);
    await store.resync();
    expect(history).toHaveBeenCalledWith(CONV);
    expect(store.messages.map((m) => m.text)).toEqual(["Salut", "Fini !"]);
    expect(store.loading).toBe(false);
  });

  test("resync does nothing while busy or without an active conversation", async () => {
    const history = vi.fn<ChatPorts["history"]>(() => Promise.resolve([]));
    const { store } = setup([], { history });
    await store.resync();
    store.send("Un");
    await store.resync();
    expect(history).not.toHaveBeenCalled();
  });

  test("resync failure keeps the messages and sets a notice", async () => {
    const history = vi.fn<ChatPorts["history"]>(() => Promise.resolve([msg("a", "Salut")]));
    const { store } = setup([], { history });
    await store.open(CONV);
    history.mockRejectedValue(new Error("boom"));
    await store.resync();
    expect(store.messages.map((m) => m.text)).toEqual(["Salut"]);
    expect(store.notice).toBe("Impossible de charger cette conversation pour l'instant.");
  });

  describe("removeConversation", () => {
    const list: ConversationSummary[] = [
      { id: CONV, title: "Lasagnes", updatedAt: "2026-10-04T13:30:00.000Z" },
      { id: CONV_B, title: "Week-end", updatedAt: "2026-10-04T13:00:00.000Z" },
    ];

    test("deleted: leaves the list, and the open conversation goes back to the welcome", async () => {
      const deleteConversation = vi.fn<ChatPorts["deleteConversation"]>(() => Promise.resolve("deleted"));
      const { store, setConversations } = setup([msg("a", "Salut")], { deleteConversation });
      setConversations(list);
      await store.refreshConversations();
      await store.open(CONV);
      expect(await store.removeConversation(CONV)).toBe("deleted");
      expect(deleteConversation).toHaveBeenCalledWith(CONV);
      expect(store.conversations.map((c) => c.id)).toEqual([CONV_B]);
      expect(store.activeId).toBeNull();
      expect(store.messages).toEqual([]);
      expect(store.notice).toBeNull();
    });

    test("not_found: leaves the list too, another open conversation stays open", async () => {
      const { store, setConversations } = setup([msg("a", "Salut")], {
        deleteConversation: () => Promise.resolve("not_found"),
      });
      setConversations(list);
      await store.refreshConversations();
      await store.open(CONV_B);
      expect(await store.removeConversation(CONV)).toBe("not_found");
      expect(store.conversations.map((c) => c.id)).toEqual([CONV_B]);
      expect(store.activeId).toBe(CONV_B);
      expect(store.messages.map((m) => m.text)).toEqual(["Salut"]);
    });

    test("busy: kept, without a chat notice", async () => {
      const { store, setConversations } = setup([msg("a", "Salut")], {
        deleteConversation: () => Promise.resolve("busy"),
      });
      setConversations(list);
      await store.refreshConversations();
      await store.open(CONV);
      expect(await store.removeConversation(CONV)).toBe("busy");
      expect(store.conversations.map((c) => c.id)).toEqual([CONV, CONV_B]);
      expect(store.activeId).toBe(CONV);
      expect(store.notice).toBeNull();
    });

    test("a refresh that started before the deletion does not bring it back", async () => {
      const pending = deferred<ConversationSummary[]>();
      let calls = 0;
      const { store } = setup([], {
        listConversations: () => (++calls === 1 ? Promise.resolve(list) : pending.promise),
        deleteConversation: () => Promise.resolve("deleted"),
      });
      await store.refreshConversations();
      const refresh = store.refreshConversations();
      await store.removeConversation(CONV);
      pending.resolve(list);
      await refresh;
      expect(store.conversations.map((c) => c.id)).toEqual([CONV_B]);
    });

    test("brain unreachable: kept, without a chat notice", async () => {
      const { store, setConversations } = setup([], {
        deleteConversation: () => Promise.reject(new Error("offline")),
      });
      setConversations(list);
      await store.refreshConversations();
      expect(await store.removeConversation(CONV)).toBe("failed");
      expect(store.conversations).toHaveLength(2);
      expect(store.notice).toBeNull();
    });
  });
});
