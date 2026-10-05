import { describe, expect, test } from "vitest";
import { confirmationNotification, notificationBody, notificationFor } from "../src/main/turn-notifications.ts";

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

describe("confirmationNotification", () => {
  const ASK = { conversationId: CONV, summary: "Oublier ce souvenir : « Kévin court le dimanche » ?" };
  const NEEDED = "Alicia a besoin de ta réponse";

  test("a card the person can see needs no notification", () => {
    expect(confirmationNotification(ASK, "main", VISIBLE)).toBeNull();
    expect(confirmationNotification(ASK, "holo", VISIBLE)).toBeNull();
  });

  test("an unseen card: a notification with the question, leading to the window that shows the card", () => {
    expect(confirmationNotification(ASK, "main", HIDDEN)).toEqual({ title: NEEDED, body: ASK.summary, conversationId: CONV, surface: "main" });
    expect(confirmationNotification(ASK, "holo", { main: true, holoChat: false })).toEqual({
      title: NEEDED, body: ASK.summary, conversationId: CONV, surface: "holo",
    });
  });

  test("a Spotlight question always: its card waits in the main window", () => {
    expect(confirmationNotification(ASK, "spotlight", VISIBLE)).toEqual({ title: NEEDED, body: ASK.summary, conversationId: CONV, surface: "main" });
  });
});

describe("notificationBody", () => {
  test("plain text: no Markdown marks, single spaces, cut at 180 characters", () => {
    expect(notificationBody("**Bonjour**  `Kévin`\n\n# Titre")).toBe("Bonjour Kévin Titre");
    const long = notificationBody("a".repeat(300));
    expect(long).toHaveLength(180);
    expect(long.endsWith("…")).toBe(true);
  });

  test("only real Markdown goes: paired marks, line-start marks, links", () => {
    expect(notificationBody("> Cite\n- un\n* deux\n1. trois\n## Fin")).toBe("Cite un deux trois Fin");
    expect(notificationBody("Lis [la recette](https://exemple.fr) et ![photo](p.png) _vite_ ~~pas~~")).toBe("Lis la recette et photo vite pas");
    expect(notificationBody("2 * 3 * 4 = 24, fichier_de_test.txt, C# et #42")).toBe("2 * 3 * 4 = 24, fichier_de_test.txt, C# et #42");
  });

  test("the cut never splits a character", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    // 181 characters as read: cut to 179, then the ellipsis.
    const body = notificationBody(`${"a".repeat(178)}${family}${family}${family}`);
    expect(body).toBe(`${"a".repeat(178)}${family}…`);
  });
});
