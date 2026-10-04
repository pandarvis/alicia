import type { ConversationSummary, HistoryMessage, SendMessage } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { ChatStore } from "../src/renderer/src/lib/chat-store.svelte.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

function setup(history: HistoryMessage[] = []) {
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
    newId: () => `00000000-0000-4000-8000-00000000000${counter++}`,
    schedule: (run, ms) => {
      const t = { run, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
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
    const { store } = setup();
    store.send("Météo ?");
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool: "weather" });
    expect(store.activity).toBe("Alicia utilise l'outil « weather »…");
    expect(store.mascot).toBe("thinking");
    store.handle({ type: "text_delta", conversationId: CONV, text: "Beau temps." });
    expect(store.activity).toBeNull();
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
});
