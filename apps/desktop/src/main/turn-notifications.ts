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

/** Markdown that only means something at the start of a line: headings, quotes, list bullets, code fences. */
const LINE_MARKS = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+|```.*$)/gmu;
/** Inline Markdown, only when its marks are paired around text (2 * 3 * 4 and file_name_here stay). */
const INLINE_MARKS: readonly (readonly [RegExp, string])[] = [
  [/!\[([^\]\n]*)\]\([^)\s]*\)/gu, "$1"],
  [/\[([^\]\n]+)\]\([^)\s]*\)/gu, "$1"],
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, "$1"],
  [/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, "$1"],
  [/(?<![\p{L}\p{N}*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu, "$1"],
  [/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, "$1"],
  [/~~(?=\S)(.+?)(?<=\S)~~/gu, "$1"],
  [/`([^`\n]+)`/gu, "$1"],
];

const graphemes = new Intl.Segmenter("fr", { granularity: "grapheme" });

/** Plain text for a notification: no Markdown marks, single spaces, at most 180 characters as read. */
export function notificationBody(text: string): string {
  let plain = text.replace(LINE_MARKS, "");
  for (const [pattern, replacement] of INLINE_MARKS) plain = plain.replace(pattern, replacement);
  plain = plain.replace(/\s+/gu, " ").trim();
  // Cut by graphemes, so an accented letter or an emoji is never split in half.
  const characters = Array.from(graphemes.segment(plain), (part) => part.segment);
  if (characters.length <= MAX_BODY) return plain;
  return `${characters.slice(0, MAX_BODY - 1).join("").trimEnd()}…`;
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
