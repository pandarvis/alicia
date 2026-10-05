import type { ConfirmMessage, ConversationSummary, HistoryMessage, SendMessage } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import type { UploadResult } from "../src/renderer/src/lib/brain-client.ts";
import { type ChatItem, ChatStore, type ChatPorts } from "../src/renderer/src/lib/chat-store.svelte.ts";

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

/** What an item says: a message's text, a card's question. */
function textOf(item: ChatItem): string {
  return item.role === "confirmation" ? item.summary : item.text;
}

function msg(id: string, text: string): HistoryMessage {
  return { id, role: "user", text, createdAt: "2026-10-04T13:30:00.000Z", attachments: [] };
}

function setup(history: HistoryMessage[] = [], overrides: Partial<ChatPorts> = {}) {
  let counter = 0;
  const sent: SendMessage[] = [];
  const confirmed: ConfirmMessage[] = [];
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const uploads: { file: File; answer: ReturnType<typeof deferred<UploadResult>> }[] = [];
  const discarded: string[] = [];
  let conversations: ConversationSummary[] = [];
  const store = new ChatStore({
    listConversations: () => Promise.resolve(conversations),
    history: () => Promise.resolve(history),
    send: (m) => {
      sent.push(m);
      return true;
    },
    confirm: (m) => {
      confirmed.push(m);
      return Promise.resolve(true);
    },
    deleteConversation: () => Promise.resolve("deleted"),
    upload: (file) => {
      const answer = deferred<UploadResult>();
      uploads.push({ file, answer });
      return answer.promise;
    },
    discardAttachment: (id) => {
      discarded.push(id);
      return Promise.resolve();
    },
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
    store, sent, confirmed, timers, uploads, discarded,
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
    expect(store.messages.map((m) => [m.role, textOf(m)])).toEqual([["user", "Salut"]]);
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
    expect(store.messages.at(-1)).toMatchObject({ streaming: false });
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

  test("tool call shows the brain's label as activity, cleared by the text", () => {
    const { store, sent } = setup();
    store.send("Météo ?");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool: "weather", label: "Alicia regarde la météo…" });
    expect(store.activity).toBe("Alicia regarde la météo…");
    expect(store.mascot).toBe("thinking");
    store.handle({ type: "text_delta", conversationId: CONV, text: "Beau temps." });
    expect(store.activity).toBeNull();
  });

  test("remembering gives the mascot an idea, other tools keep it thinking", () => {
    const { store, sent } = setup();
    store.send("Retiens ça");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool: "memory_remember", label: "Alicia retient ça…" });
    expect(store.mascot).toBe("idea");
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t2", tool: "memory_search", label: "Alicia fouille dans sa mémoire…" });
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
      { id: "a", role: "user", text: "Salut", createdAt: "2026-10-04T13:30:00.000Z", attachments: [] },
      { id: "b", role: "assistant", text: "Coucou !", createdAt: "2026-10-04T13:30:01.000Z", attachments: [] },
    ]);
    await store.open(CONV);
    expect(store.activeId).toBe(CONV);
    expect(store.messages.map((m) => textOf(m))).toEqual(["Salut", "Coucou !"]);
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
    expect(store.messages.map((m) => textOf(m))).toEqual(["Deuxième"]);
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
    expect(store.messages.map((m) => textOf(m))).toEqual(["Deuxième"]);
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
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t", tool: "weather", label: "Alicia regarde la météo…" });
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
    store.handle({ type: "tool_call", conversationId: CONV_B, callId: "t", tool: "weather", label: "Alicia regarde la météo…" });
    store.handle({ type: "done", conversationId: CONV_B, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    expect(store.messages.map((m) => textOf(m))).toEqual(["Nouvelle question"]);
    expect([store.busy, store.activity]).toEqual([true, null]);
    // Its own conversation arrives: from now on, its events count.
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "text_delta", conversationId: CONV_B, text: "Encore" });
    store.handle({ type: "text_delta", conversationId: CONV, text: "Réponse" });
    store.handle({ type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0 });
    expect(store.messages.map((m) => textOf(m))).toEqual(["Nouvelle question", "Réponse"]);
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
    expect(store.messages.map((m) => textOf(m))).toEqual(["Un"]);
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
    expect(store.messages.map((m) => textOf(m))).toEqual(["Salut", "Fini !"]);
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
    expect(store.messages.map((m) => textOf(m))).toEqual(["Salut"]);
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
      expect(store.messages.map((m) => textOf(m))).toEqual(["Salut"]);
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

const CONFIRMATION = "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6";
const ASKED = "9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e";
const ASK = {
  type: "confirm_request", conversationId: CONV, messageId: ASKED, confirmationId: CONFIRMATION, tool: "memory_forget",
  summary: "Oublier ce souvenir : « Kévin adore les lasagnes » ?", expiresAt: "2026-10-05T10:05:00.000Z",
} as const;

describe("confirmations", () => {
  /** A turn of this window, in conversation CONV. */
  function asking(overrides: Partial<ChatPorts> = {}) {
    const context = setup([], overrides);
    context.store.send("Oublie les lasagnes");
    context.store.handle({ type: "conversation", requestId: context.sent[0]?.requestId ?? "", conversationId: CONV });
    return context;
  }

  test("a request closes the streaming bubble and adds a pending card; no typing dots meanwhile", () => {
    const { store } = asking();
    store.handle({ type: "text_delta", conversationId: CONV, text: "Je vérifie." });
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool: "memory_forget", label: "Alicia oublie ce souvenir…" });
    store.handle(ASK);
    expect(store.messages.at(-2)).toMatchObject({ role: "assistant", text: "Je vérifie.", streaming: false });
    expect(store.messages.at(-1)).toMatchObject({ role: "confirmation", confirmationId: CONFIRMATION, status: "pending", summary: ASK.summary });
    expect(store.activity).toBeNull();
    expect(store.waiting).toBe(false);
    expect(store.mascot).toBe("alert");
  });

  test("answering sends confirm; the brain's result settles the card; the answer continues below", async () => {
    const { store, confirmed } = asking();
    store.handle(ASK);
    store.respond(CONFIRMATION, true);
    expect(confirmed).toEqual([{ type: "confirm", confirmationId: CONFIRMATION, approved: true }]);
    expect(store.messages.at(-1)).toMatchObject({ role: "confirmation", status: "answering" });
    store.respond(CONFIRMATION, false);
    expect(confirmed).toHaveLength(1);
    await Promise.resolve();
    store.handle({ type: "confirm_result", conversationId: CONV, confirmationId: CONFIRMATION, outcome: "approved" });
    expect(store.messages.at(-1)).toMatchObject({ role: "confirmation", status: "approved" });
    expect(store.waiting).toBe(true);
    expect(store.mascot).toBe("thinking");
    store.handle({ type: "text_delta", conversationId: CONV, text: "C'est oublié." });
    expect(store.messages.at(-1)).toMatchObject({ role: "assistant", text: "C'est oublié.", streaming: true });
  });

  test("the answer cannot leave (offline, refused): notice, card pending again", async () => {
    const { store } = asking({ confirm: () => Promise.resolve(false) });
    store.handle(ASK);
    store.respond(CONFIRMATION, true);
    await vi.waitFor(() => { expect(store.notice).toBe("Alicia n'est pas joignable pour l'instant."); });
    expect(store.messages.at(-1)).toMatchObject({ status: "pending" });
  });

  test("connection lost: cards still waiting become cancelled", () => {
    const { store } = asking();
    store.handle(ASK);
    store.connectionLost();
    expect(store.messages.at(-1)).toMatchObject({ role: "confirmation", status: "cancelled" });
  });

  test("a request for another conversation, not open here, does not show", () => {
    const { store } = asking();
    store.handle({ ...ASK, conversationId: CONV_B });
    expect(store.messages.some((m) => m.role === "confirmation")).toBe(false);
  });

  test("another window's card routed here (a Spotlight turn) shows when its conversation is open, and can be answered", async () => {
    const history = [msg(ASKED, "Oublie les lasagnes")];
    const { store, confirmed } = setup(history);
    store.handle(ASK);
    expect(store.messages).toEqual([]);
    await store.open(CONV);
    expect(store.messages.map((m) => m.role)).toEqual(["user", "confirmation"]);
    store.respond(CONFIRMATION, false);
    expect(confirmed).toEqual([{ type: "confirm", confirmationId: CONFIRMATION, approved: false }]);
    store.handle({ type: "confirm_result", conversationId: CONV, confirmationId: CONFIRMATION, outcome: "refused" });
    expect(store.messages.at(-1)).toMatchObject({ status: "refused" });
    // Its turn ends: the history is reloaded with the answer; the card stays after its question.
    history.push({ id: "m2", role: "assistant", text: "Je le garde.", createdAt: "2026-10-04T13:31:00.000Z", attachments: [] });
    store.handle({ type: "done", conversationId: CONV, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1 });
    await vi.waitFor(() => { expect(store.messages.map((m) => m.role)).toEqual(["user", "confirmation", "assistant"]); });
    expect(store.messages[1]).toMatchObject({ status: "refused" });
    // Leaving the conversation forgets it.
    store.startNew();
    await store.open(CONV);
    expect(store.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("a card routed here while its conversation is already open shows at once", async () => {
    const { store } = setup([msg(ASKED, "Oublie les lasagnes")]);
    await store.open(CONV);
    store.handle(ASK);
    expect(store.messages.at(-1)).toMatchObject({ role: "confirmation", status: "pending" });
  });

  test("a card routed here stays right after the message it belongs to, whatever was said since", async () => {
    const history: HistoryMessage[] = [msg(ASKED, "Oublie les lasagnes")];
    const { store, sent } = setup(history);
    await store.open(CONV);
    store.handle(ASK);
    store.handle({ type: "confirm_result", conversationId: CONV, confirmationId: CONFIRMATION, outcome: "refused" });
    store.handle({ type: "done", conversationId: CONV, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1 });
    // The person goes on here: a new question and its answer come after the card.
    store.send("Et la recette ?");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({ type: "done", conversationId: CONV, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1 });
    history.push(
      { id: "m2", role: "assistant", text: "Je le garde.", createdAt: "2026-10-04T13:31:00.000Z", attachments: [] },
      { id: "m3", role: "user", text: "Et la recette ?", createdAt: "2026-10-04T13:32:00.000Z", attachments: [] },
      { id: "m4", role: "assistant", text: "La voici.", createdAt: "2026-10-04T13:33:00.000Z", attachments: [] },
    );
    await store.resync();
    expect(store.messages.map((m) => textOf(m))).toEqual([
      "Oublie les lasagnes", ASK.summary, "Je le garde.", "Et la recette ?", "La voici.",
    ]);
  });
  test("this window's own card survives a reload of the history (back online), cancelled, after its message", async () => {
    const history: HistoryMessage[] = [];
    const { store, sent } = setup(history);
    store.send("Oublie les lasagnes");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle(ASK);
    store.connectionLost();
    history.push(msg(ASKED, "Oublie les lasagnes"));
    await store.resync();
    expect(store.messages.map((m) => [m.role, m.role === "confirmation" ? m.status : ""])).toEqual([
      ["user", ""], ["confirmation", "cancelled"],
    ]);
  });

  describe("a Spotlight card (another window's turn, shown here) is never lost", () => {
    const DONE = { type: "done", model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1 } as const;

    test("asked while this window answers elsewhere: kept, announced, answerable once its conversation opens", async () => {
      const { store, sent, confirmed } = setup([msg(ASKED, "Oublie les lasagnes")]);
      store.send("Bonjour");
      store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV_B });
      store.handle(ASK);
      expect(store.messages.some((m) => m.role === "confirmation")).toBe(false);
      expect(store.awaitingElsewhere).toBe(CONV);
      // The person asks for it while the answer still streams: opened once it has ended.
      store.openWhenIdle(CONV);
      store.handle({ ...DONE, conversationId: CONV_B });
      await vi.waitFor(() => { expect(store.messages.map((m) => m.role)).toEqual(["user", "confirmation"]); });
      expect(store.awaitingElsewhere).toBeNull();
      store.respond(CONFIRMATION, true);
      expect(confirmed).toEqual([{ type: "confirm", confirmationId: CONFIRMATION, approved: true }]);
    });

    test("leaving its conversation while it waits (new conversation, another one) keeps it", async () => {
      const { store } = setup([msg(ASKED, "Oublie les lasagnes")]);
      await store.open(CONV);
      store.handle(ASK);
      store.startNew();
      expect(store.awaitingElsewhere).toBe(CONV);
      await store.open(CONV_B);
      expect(store.awaitingElsewhere).toBe(CONV);
      await store.open(CONV);
      expect(store.messages.at(-1)).toMatchObject({ role: "confirmation", confirmationId: CONFIRMATION, status: "pending" });
      expect(store.awaitingElsewhere).toBeNull();
    });

    test("typing in its conversation (busy) leaves it there, answerable", async () => {
      const { store, confirmed } = setup([msg(ASKED, "Oublie les lasagnes")]);
      await store.open(CONV);
      store.handle(ASK);
      store.send("Attends, je réfléchis");
      expect(store.messages.some((m) => m.role === "confirmation" && m.status === "pending")).toBe(true);
      store.respond(CONFIRMATION, false);
      expect(confirmed).toEqual([{ type: "confirm", confirmationId: CONFIRMATION, approved: false }]);
    });

    test("an answered card is not announced; once its turn ended, it is forgotten when its conversation is left", async () => {
      const { store } = setup([msg(ASKED, "Oublie les lasagnes")]);
      await store.open(CONV);
      store.handle(ASK);
      store.respond(CONFIRMATION, true);
      store.startNew();
      expect(store.awaitingElsewhere).toBeNull();
      store.handle({ type: "confirm_result", conversationId: CONV, confirmationId: CONFIRMATION, outcome: "approved" });
      store.handle({ ...DONE, conversationId: CONV });
      await store.open(CONV);
      expect(store.messages.map((m) => m.role)).toEqual(["user"]);
    });

    test("settled but its turn still running: it comes back with its conversation", async () => {
      const { store } = setup([msg(ASKED, "Oublie les lasagnes")]);
      await store.open(CONV);
      store.handle(ASK);
      store.handle({ type: "confirm_result", conversationId: CONV, confirmationId: CONFIRMATION, outcome: "refused" });
      store.startNew();
      await store.open(CONV);
      expect(store.messages.at(-1)).toMatchObject({ role: "confirmation", status: "refused" });
    });

    test("connection lost: a card waiting elsewhere is cancelled and no longer announced", () => {
      const { store } = setup();
      store.handle(ASK);
      expect(store.awaitingElsewhere).toBe(CONV);
      store.connectionLost();
      expect(store.awaitingElsewhere).toBeNull();
    });

    test("its turn fails instead of ending: the settled card is released all the same", async () => {
      const { store } = setup([msg(ASKED, "Oublie les lasagnes")]);
      store.handle(ASK);
      store.handle({ type: "confirm_result", conversationId: CONV, confirmationId: CONFIRMATION, outcome: "cancelled" });
      store.handle({ type: "error", requestId: "5d1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", conversationId: CONV, code: "engine", message: "Raté." });
      expect(store.notice).toBeNull();
      await store.open(CONV);
      expect(store.messages.map((m) => m.role)).toEqual(["user"]);
    });

    test("awaitingAnywhere also names a waiting card of the open conversation (for a screen other than the chat)", async () => {
      const { store } = setup([msg(ASKED, "Oublie les lasagnes")]);
      expect(store.awaitingAnywhere).toBeNull();
      await store.open(CONV);
      store.handle(ASK);
      expect(store.awaitingElsewhere).toBeNull();
      expect(store.awaitingAnywhere).toBe(CONV);
      store.respond(CONFIRMATION, true);
      expect(store.awaitingAnywhere).toBeNull();
    });
  });

});

describe("attachments", () => {
  const fileOf = (name: string, size = 3) => new File([new Uint8Array(size)], name);
  const SUMMARY = (id: string, name: string) => ({ ok: true as const, attachment: { id, name, kind: "pdf" as const, size: 3 } });
  const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  test("unsupported, empty or too big: refused at once, nothing uploaded", () => {
    const { store, uploads } = setup();
    store.addFiles([fileOf("film.mp4"), fileOf("vide.txt", 0), fileOf("scan.pdf", 25 * 1024 * 1024 + 1)]);
    expect(store.drafts).toEqual([]);
    expect(uploads).toEqual([]);
    expect(store.notice).toBe(
      "« film.mp4 » n'est pas pris en charge : images, PDF, Word (.docx), Excel (.xlsx) et texte (.txt, .csv). « vide.txt » est vide. « scan.pdf » est trop gros (25 Mo) : 25 Mo au maximum.",
    );
  });

  test("a chip uploads, then is ready; sending waits for it and carries its id", async () => {
    const { store, uploads, sent } = setup();
    store.addFiles([fileOf("facture.pdf")]);
    expect(store.drafts).toMatchObject([{ name: "facture.pdf", kind: "pdf", status: "uploading" }]);
    expect(uploads[0]?.file.name).toBe("facture.pdf");
    expect(store.canSend("")).toBe(false);
    expect(store.canSend("Combien ?")).toBe(false);
    expect(store.send("Combien ?")).toBe(false);
    uploads[0]?.answer.resolve(SUMMARY(A1, "facture.pdf"));
    await vi.waitFor(() => { expect(store.drafts[0]?.status).toBe("ready"); });
    expect(store.canSend("")).toBe(true);
    expect(store.send("")).toBe(true);
    expect(sent[0]).toMatchObject({ type: "send", text: "", attachments: [A1] });
    expect(store.messages.at(-1)).toMatchObject({ role: "user", text: "", attachments: [{ name: "facture.pdf", kind: "pdf" }] });
    expect(store.drafts).toEqual([]);
  });

  test("a message without files carries no attachments field", () => {
    const { store, sent } = setup();
    store.send("Salut");
    expect(sent[0]).not.toHaveProperty("attachments");
    expect(store.messages.at(-1)).not.toHaveProperty("attachments");
  });

  test("upload refused by the brain, or failing: failed chip and the reason; it does not block sending", async () => {
    const { store, uploads } = setup();
    store.addFiles([fileOf("photo.pdf"), fileOf("b.pdf")]);
    uploads[0]?.answer.resolve({ ok: false, reason: "unsupported" });
    await vi.waitFor(() => { expect(store.drafts[0]?.status).toBe("failed"); });
    expect(store.notice).toContain("« photo.pdf » n'est pas pris en charge");
    uploads[1]?.answer.reject(new Error("réseau"));
    await vi.waitFor(() => { expect(store.drafts[1]?.status).toBe("failed"); });
    expect(store.notice).toBe("« b.pdf » n'a pas pu être envoyé à Alicia : retire-le et réessaie.");
    expect(store.canSend("")).toBe(false);
    expect(store.canSend("Quand même")).toBe(true);
  });

  test("removing a chip forgets the upload on the brain, even when it finishes afterwards", async () => {
    const { store, uploads, discarded } = setup();
    store.addFiles([fileOf("a.pdf"), fileOf("b.pdf")]);
    uploads[0]?.answer.resolve(SUMMARY(A1, "a.pdf"));
    await vi.waitFor(() => { expect(store.drafts[0]?.status).toBe("ready"); });
    store.removeDraft(store.drafts[0]?.localId ?? "");
    store.removeDraft(store.drafts[0]?.localId ?? "");
    expect(store.drafts).toEqual([]);
    uploads[1]?.answer.resolve(SUMMARY(B1, "b.pdf"));
    await vi.waitFor(() => { expect(discarded).toEqual([A1, B1]); });
    expect(store.drafts).toEqual([]);
  });

  test("ten at most per message", () => {
    const { store, uploads } = setup();
    store.addFiles(Array.from({ length: 11 }, (_, i) => fileOf(`f${i}.pdf`)));
    expect(store.drafts).toHaveLength(10);
    expect(uploads).toHaveLength(10);
    expect(store.notice).toBe("10 pièces jointes au maximum par message.");
  });

  test("a failed chip does not take one of the ten places", async () => {
    const { store, uploads } = setup();
    store.addFiles(Array.from({ length: 10 }, (_, i) => fileOf(`f${i}.pdf`)));
    uploads[0]?.answer.resolve({ ok: false, reason: "failed" });
    await vi.waitFor(() => { expect(store.drafts[0]?.status).toBe("failed"); });
    store.addFiles([fileOf("onze.pdf")]);
    expect(store.drafts.map((d) => d.name)).toContain("onze.pdf");
    store.addFiles([fileOf("douze.pdf")]);
    expect(store.drafts.map((d) => d.name)).not.toContain("douze.pdf");
  });

  test("files the brain no longer has: the message is refused, its files come back and upload again", async () => {
    const { store, uploads, sent, discarded } = setup();
    store.addFiles([fileOf("facture.pdf")]);
    uploads[0]?.answer.resolve(SUMMARY(A1, "facture.pdf"));
    await vi.waitFor(() => { expect(store.drafts[0]?.status).toBe("ready"); });
    store.send("Combien ?");
    expect(store.drafts).toEqual([]);
    store.handle({
      type: "error", requestId: sent[0]?.requestId ?? "", code: "invalid_request",
      message: "Pièce jointe introuvable ou expirée : joins-la à nouveau.",
    });
    expect(store.busy).toBe(false);
    expect(store.drafts).toMatchObject([{ name: "facture.pdf", status: "uploading" }]);
    expect(uploads[1]?.file.name).toBe("facture.pdf");
    expect(discarded).toEqual([A1]);
    expect(store.notice).toBe("Une pièce jointe n'était plus disponible : les fichiers sont renvoyés, envoie à nouveau ton message.");
  });

  test("once the turn went through, the sent files are forgotten (another error brings nothing back)", async () => {
    const { store, uploads, sent } = setup();
    store.addFiles([fileOf("facture.pdf")]);
    uploads[0]?.answer.resolve(SUMMARY(A1, "facture.pdf"));
    await vi.waitFor(() => { expect(store.drafts[0]?.status).toBe("ready"); });
    store.send("Combien ?");
    store.handle({ type: "error", requestId: sent[0]?.requestId ?? "", code: "engine", message: "Raté." });
    expect(store.drafts).toEqual([]);
    expect(store.notice).toBe("Raté.");
  });

  test("files wait in the composer across conversations (a pending upload belongs to none)", async () => {
    const { store } = setup();
    store.addFiles([fileOf("a.pdf")]);
    await store.open(CONV);
    store.startNew();
    expect(store.drafts).toHaveLength(1);
  });

  test("history shows the files sent with a message", async () => {
    const { store } = setup([{ ...msg("m1", "Regarde"), attachments: [{ id: A1, name: "facture.pdf", kind: "pdf", size: 3 }] }, msg("m2", "Merci")]);
    await store.open(CONV);
    expect(store.messages[0]).toMatchObject({ attachments: [{ name: "facture.pdf", kind: "pdf" }] });
    expect(store.messages[1]).not.toHaveProperty("attachments");
  });
});
