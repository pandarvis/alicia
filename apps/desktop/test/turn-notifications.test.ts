import { describe, expect, test } from "vitest";
import { notificationBody, notificationFor } from "../src/main/turn-notifications.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";
const VISIBLE = { main: true, holoChat: true };
const HIDDEN = { main: false, holoChat: false };

describe("notificationFor", () => {
  test("Spotlight answers always come as a notification that opens the conversation", () => {
    const turn = { origin: "spotlight", outcome: "answered", conversationId: CONV, text: "Il fait beau." } as const;
    expect(notificationFor(turn, VISIBLE)).toEqual({ title: "Alicia", body: "Il fait beau.", conversationId: CONV, openConversation: true });
  });

  test("main window: only when hidden, and the conversation is already the open one", () => {
    const turn = { origin: "main", outcome: "answered", conversationId: CONV, text: "Voilà." } as const;
    expect(notificationFor(turn, VISIBLE)).toBeNull();
    expect(notificationFor(turn, HIDDEN)).toEqual({ title: "Alicia", body: "Voilà.", conversationId: CONV, openConversation: false });
  });

  test("Holo: only when its mini-chat is closed", () => {
    const turn = { origin: "holo", outcome: "answered", conversationId: CONV, text: "Oui !" } as const;
    expect(notificationFor(turn, { main: false, holoChat: true })).toBeNull();
    expect(notificationFor(turn, { main: true, holoChat: false })?.openConversation).toBe(true);
  });

  test("a failure says so, with the brain's message", () => {
    const turn = { origin: "spotlight", outcome: "failed", conversationId: undefined, message: "Alicia répond déjà." } as const;
    expect(notificationFor(turn, VISIBLE)).toEqual({
      title: "Alicia n'a pas pu répondre", body: "Alicia répond déjà.", conversationId: undefined, openConversation: false,
    });
  });

  test("an empty answer still says something", () => {
    const turn = { origin: "spotlight", outcome: "answered", conversationId: CONV, text: "  " } as const;
    expect(notificationFor(turn, VISIBLE)?.body).toBe("Alicia a répondu.");
  });
});

describe("notificationBody", () => {
  test("plain text: no Markdown marks, single spaces, cut at 180 characters", () => {
    expect(notificationBody("**Bonjour**  `Kévin`\n\n# Titre")).toBe("Bonjour Kévin Titre");
    const long = notificationBody("a".repeat(300));
    expect(long).toHaveLength(180);
    expect(long.endsWith("…")).toBe(true);
  });
});
