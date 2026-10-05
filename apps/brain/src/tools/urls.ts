const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'«»]+|\bwww\.[^\s<>"'«»]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const DISPLAY_MAX = 120;

/**
 * Comparable form of a web address: host (lowercase, punycode, default port dropped) + path without trailing
 * slash + query. Scheme, credentials and fragment do not count. Undefined for anything but http(s).
 */
export function urlKey(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") return undefined;
  return `${url.host}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
}

/** The addresses written in the person's message, in comparable form. */
export function userUrls(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const key = urlKey(match[0].replace(TRAILING_PUNCTUATION, ""));
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/** An address as shown on a card: at most 120 characters. */
export function displayUrl(raw: string): string {
  return raw.length > DISPLAY_MAX ? `${raw.slice(0, DISPLAY_MAX - 1)}…` : raw;
}
