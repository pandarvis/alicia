import { describe, expect, test } from "vitest";
import { displayUrl, isLocalHost, parseWebUrl, urlKey, userUrls } from "../src/tools/urls.ts";

describe("urlKey", () => {
  test.each([
    ["https://Example.com/Page/", "example.com/Page"],
    // Only one trailing slash is dropped: "/a//" is another address than "/a".
    ["https://example.com/a//", "example.com/a/"],
    ["http://example.com:80/a?b=1#haut", "example.com/a?b=1"],
    ["https://example.com", "example.com"],
    ["www.impots.gouv.fr/portail", "www.impots.gouv.fr/portail"],
    ["https://example.com:8443/x", "example.com:8443/x"],
    // Credentials never make another host look like the person's: the host is what counts.
    ["https://meteo.fr@evil.example/paris", "evil.example/paris"],
    ["https://météo.fr/paris", "xn--mto-bmab.fr/paris"],
  ])("%s → %s", (raw, key) => {
    expect(urlKey(raw)).toBe(key);
  });
  test.each(["ftp://example.com/x", "file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,x", "pas une adresse", ""])(
    "%s → none",
    (raw) => {
      expect(urlKey(raw)).toBeUndefined();
    },
  );
});

test("parseWebUrl: http(s) with a host only", () => {
  expect(parseWebUrl("https://example.com/a")?.href).toBe("https://example.com/a");
  expect(parseWebUrl("www.example.com")?.host).toBe("www.example.com");
  for (const raw of ["file:///C:/x", "javascript:alert(1)", "mailto:a@b.fr", "x y"]) expect(parseWebUrl(raw), raw).toBeUndefined();
});

test("userUrls finds the addresses written in the message, without trailing punctuation", () => {
  expect(userUrls("Regarde https://meteo.fr/paris, et aussi www.Impots.gouv.fr/portail. Merci !")).toEqual(
    new Set(["meteo.fr/paris", "www.impots.gouv.fr/portail"]),
  );
  expect(userUrls("(voir https://exemple.fr/a)")).toEqual(new Set(["exemple.fr/a"]));
  expect(userUrls("Rien ici")).toEqual(new Set());
});

describe("displayUrl", () => {
  const show = (raw: string): string => {
    const url = parseWebUrl(raw);
    if (url === undefined) throw new Error(raw);
    return displayUrl(url);
  };

  test("the address as parsed: punycode host, invisible and direction characters percent-encoded", () => {
    expect(show("https://аpple.com/")).toBe("https://xn--pple-43d.com/");
    expect(show("https://example.com/\u202Egnp.exe")).toBe("https://example.com/%E2%80%AEgnp.exe");
    expect(show("https://example.com/a")).toBe("https://example.com/a");
  });

  test("long addresses are cut at the end (the host is never what is cut)", () => {
    const shown = show(`https://example.com/${"a".repeat(400)}`);
    expect(shown).toHaveLength(200);
    expect(shown.startsWith("https://example.com/")).toBe(true);
    expect(shown.endsWith("…")).toBe(true);
  });
});

describe("isLocalHost", () => {
  test.each([
    "http://localhost:8123/", "http://app.localhost/", "http://127.0.0.1/", "http://127.1/", "http://0x7f000001/",
    "http://0.0.0.0/", "http://10.0.0.5/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/",
    "http://100.64.0.1/", "http://100.127.255.255/", "http://169.254.169.254/latest/meta-data",
    "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fd12:3456::1]/", "http://[fc00::1]/",
    "http://[::ffff:192.168.1.1]/", "http://[::ffff:127.0.0.1]/",
    "http://box.local/", "http://homeassistant:8123/", "http://nas.lan/", "http://imprimante.home.arpa/",
    "http://service.internal/", "https://alicia.mon-reseau.ts.net/",
    // IPv4 inside IPv6 (compatible, NAT64, 6to4), multicast, benchmarking and reserved ranges, local suffixes.
    "http://[::192.168.1.1]/", "http://[64:ff9b::10.0.0.1]/", "http://[2002:c0a8:0101::1]/", "http://[ff02::1]/",
    "http://198.18.0.1/", "http://198.19.255.1/", "http://224.0.0.1/", "http://255.255.255.255/",
    "http://nas.localdomain/", "http://box.home/", "http://intranet.corp/", "http://localhost./",
  ])("%s is local", (raw) => {
    const url = parseWebUrl(raw);
    expect(url === undefined ? undefined : isLocalHost(url)).toBe(true);
  });

  test.each([
    "https://example.com/", "http://172.32.0.1/", "http://172.15.0.1/", "http://100.128.0.1/", "http://100.63.0.1/",
    "http://8.8.8.8/", "http://[2001:db8::1]/", "http://[::ffff:8.8.8.8]/", "https://local.example.com/",
    "http://evil.com./", "http://[64:ff9b::8.8.8.8]/", "http://[2002:0808:0808::1]/", "http://198.20.0.1/", "http://223.255.255.1/",
  ])("%s is not", (raw) => {
    const url = parseWebUrl(raw);
    expect(url === undefined ? undefined : isLocalHost(url)).toBe(false);
  });
});
