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
