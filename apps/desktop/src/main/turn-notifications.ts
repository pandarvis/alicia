import type { FinishedTurn } from "./brain-hub.ts";

/** Which surfaces the person can see right now. */
export interface Visibility {
  /** Main window shown and not minimized. */
  main: boolean;
  /** Holo shown with its mini-chat open. */
  holoChat: boolean;
}

export interface TurnNotification {
  title: string;
  body: string;
  conversationId: string | undefined;
  /** True when a click must open this conversation in the main window (it came from Spotlight or the Holo). */
  openConversation: boolean;
}

const MAX_BODY = 180;

/** Plain text for a notification: no Markdown marks, single spaces, at most 180 characters. */
export function notificationBody(text: string): string {
  const plain = text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  return plain.length > MAX_BODY ? `${plain.slice(0, MAX_BODY - 1).trimEnd()}…` : plain;
}

/** A Windows notification when the answer would otherwise go unseen; null when the asking window shows it. */
export function notificationFor(turn: FinishedTurn, visible: Visibility): TurnNotification | null {
  const unseen =
    turn.origin === "spotlight" ||
    (turn.origin === "main" && !visible.main) ||
    (turn.origin === "holo" && !visible.holoChat);
  if (!unseen) return null;
  const elsewhere = turn.origin !== "main";
  if (turn.outcome === "answered") {
    const body = notificationBody(turn.text);
    return { title: "Alicia", body: body === "" ? "Alicia a répondu." : body, conversationId: turn.conversationId, openConversation: elsewhere };
  }
  return {
    title: "Alicia n'a pas pu répondre",
    body: notificationBody(turn.message),
    conversationId: turn.conversationId,
    openConversation: elsewhere && turn.conversationId !== undefined,
  };
}
