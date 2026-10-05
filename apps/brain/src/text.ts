/**
 * At most `max` UTF-16 units, the ellipsis included when cut. Never splits a surrogate pair: an emoji
 * cut in half would leave an invalid character in a title, a prompt or a confirmation card.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd8_00 && last <= 0xdb_ff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Characters a confirmation card cannot show: invisible format characters (zero-width, direction marks, tags…),
 * variation selectors, the combining grapheme joiner, and the fillers that look like nothing (Hangul fillers,
 * the blank Braille pattern). They could carry data the person never sees.
 */
const HIDDEN_CHARACTERS = /[\p{Cf}\u{034F}\u{115F}\u{1160}\u{2800}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}\u{E0100}-\u{E01EF}]/u;

/** True when `text` holds a character the person could not see on a card (see HIDDEN_CHARACTERS). */
export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_CHARACTERS.test(text);
}

/**
 * Text written by someone else than the person speaking now (a file name, an earlier message), defused before it
 * goes into a prompt: an `@path` in it would make the SDK attach that file. `@` becomes a full-width `＠`.
 */
export function defuseMentions(text: string): string {
  return text.replaceAll("@", "＠");
}
