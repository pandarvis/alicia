const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'«»]+|\bwww\.[^\s<>"'«»]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const DISPLAY_MAX = 200;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
/** Names that only ever mean a machine of the house (or of its private network). */
const LOCAL_SUFFIXES = [
  ".localhost", ".local", ".localdomain", ".lan", ".home", ".home.arpa", ".internal", ".corp", ".ts.net",
];

/** A web address (http or https, with a host), scheme optional ("www.…"); undefined for anything else. */
export function parseWebUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "" ? url : undefined;
}

/**
 * Comparable form of a web address: host (lowercase, punycode, default port dropped) + path without one trailing
 * slash + query. Scheme, credentials and fragment do not count. Undefined for anything but http(s).
 */
export function urlKey(raw: string): string | undefined {
  const url = parseWebUrl(raw);
  return url === undefined ? undefined : `${url.host}${url.pathname.replace(/\/$/u, "")}${url.search}`;
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

/**
 * An address as shown on a card: its parsed form (punycode host, every invisible or direction character of the
 * path, query and fragment percent-encoded by the parser), at most 200 characters, cut at the end only.
 */
export function displayUrl(url: URL): string {
  const href = url.href;
  return href.length > DISPLAY_MAX ? `${href.slice(0, DISPLAY_MAX - 1)}…` : href;
}

function isPrivateIpv4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127) // CGNAT, Tailscale
    || (a === 169 && b === 254) // link-local (cloud metadata too)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 224; // multicast, reserved, broadcast
}

/** Whether the IPv4 address held in two 16-bit groups is private (only its first two bytes matter). */
const ipv4In = (high: number): boolean => isPrivateIpv4(high >> 8, high & 0xff);

/** The eight 16-bit groups of an IPv6 address (as the URL parser writes it: lowercase hex, "::" possible). */
function ipv6Groups(address: string): number[] | undefined {
  const [head = "", tail] = address.split("::");
  const part = (text: string): number[] => (text === "" ? [] : text.split(":").map((g) => Number.parseInt(g, 16)));
  const front = part(head);
  const back = tail === undefined ? [] : part(tail);
  const missing = 8 - front.length - back.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return undefined;
  const groups = [...front, ...Array<number>(missing).fill(0), ...back];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xff_ff) ? groups : undefined;
}

function isPrivateIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (groups === undefined) return true; // unreadable: treated as local (asks)
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0] = groups;
  const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::, ::1 and IPv4-compatible (::a.b.c.d), IPv4-mapped (::ffff:a.b.c.d).
  if (zeroHead && (g5 === 0 || g5 === 0xff_ff)) return ipv4In(g6);
  // NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:a.b.c.d::): the IPv4 address inside decides.
  if (g0 === 0x64 && g1 === 0xff_9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4In(g6);
  if (g0 === 0x20_02) return ipv4In(g1);
  return (g0 & 0xfe_00) === 0xfc_00 // unique local
    || (g0 & 0xff_c0) === 0xfe_80 // link-local
    || (g0 & 0xff_c0) === 0xfe_c0 // site-local (deprecated)
    || (g0 & 0xff_00) === 0xff_00; // multicast
}

/**
 * A machine of the house or of its private network: loopback, private, CGNAT (Tailscale) and link-local addresses,
 * IPv6 unique-local, link-local and multicast, IPv4 inside IPv6 (compatible, mapped, NAT64, 6to4), multicast and
 * reserved IPv4 ranges, single-label names and local suffixes (.local, .lan, .home, .ts.net…).
 * By name only: a public name resolving to a private address is not caught here (no DNS lookup, on purpose for now).
 */
export function isLocalHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return isPrivateIpv6(host.slice(1, -1));
  const ipv4 = IPV4.exec(host);
  if (ipv4 !== null) return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));
  const name = host.replace(/\.$/u, "");
  return !name.includes(".") || name === "localhost" || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
