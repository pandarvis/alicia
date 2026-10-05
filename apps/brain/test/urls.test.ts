import { describe, expect, test } from "vitest";
import { displayUrl, urlKey, userUrls } from "../src/tools/urls.ts";

describe("urlKey", () => {
  test.each([
    ["https://Example.com/Page/", "example.com/Page"],
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

test("userUrls finds the addresses written in the message, without trailing punctuation", () => {
  expect(userUrls("Regarde https://meteo.fr/paris, et aussi www.Impots.gouv.fr/portail. Merci !")).toEqual(
    new Set(["meteo.fr/paris", "www.impots.gouv.fr/portail"]),
  );
  expect(userUrls("(voir https://exemple.fr/a)")).toEqual(new Set(["exemple.fr/a"]));
  expect(userUrls("Rien ici")).toEqual(new Set());
});

test("displayUrl cuts long addresses", () => {
  expect(displayUrl(`https://example.com/${"a".repeat(200)}`)).toHaveLength(120);
  expect(displayUrl("https://example.com/a")).toBe("https://example.com/a");
});
