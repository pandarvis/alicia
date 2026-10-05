import { describe, expect, test } from "vitest";
import { parseConfig, readAuthentication } from "../src/config.ts";

const MINIMAL_YAML = `
people:
  - { id: kevin, name: Kévin }
  - { id: elodie, name: Élodie }
engine:
  mode: subscription
`;

describe("parseConfig", () => {
  test("'common' is reserved and can't be a person id", () => {
    expect(() => parseConfig("people: [{ id: common, name: Tous }]\nengine: { mode: subscription }")).toThrow(/common/);
  });

  test("applies the defaults", () => {
    const c = parseConfig(MINIMAL_YAML);
    expect(c.port).toBe(8780);
    expect(c.host).toBe("0.0.0.0");
    expect(c.discovery).toBe(true);
    expect(c.timezone).toBe("Europe/Paris");
    expect(c.models).toEqual({ sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
    expect(c.people.map((p) => p.id)).toEqual(["kevin", "elodie"]);
  });
  test("home coordinates: optional, checked", () => {
    expect(parseConfig(MINIMAL_YAML).home).toBeUndefined();
    expect(parseConfig(`${MINIMAL_YAML}home: { latitude: 48.85, longitude: 2.35 }\n`).home).toEqual({ latitude: 48.85, longitude: 2.35 });
    for (const home of ["{ latitude: 120, longitude: 2.35 }", "{ latitude: 48.85, longitude: -181 }", "{ latitude: 48.85 }", "Paris"]) {
      expect(() => parseConfig(`${MINIMAL_YAML}home: ${home}\n`), home).toThrow();
    }
  });
  test("discovery can be turned off", () => {
    expect(parseConfig(`${MINIMAL_YAML}discovery: false\n`).discovery).toBe(false);
  });
  test("rejects a config without any person", () => {
    expect(() => parseConfig("people: []\nengine: { mode: subscription }")).toThrow();
  });
  test("rejects an unknown engine mode", () => {
    expect(() => parseConfig("people: [{ id: kevin, name: K }]\nengine: { mode: free }")).toThrow();
  });
  test("timezone: an IANA name, refused with a French message otherwise", () => {
    expect(parseConfig(`${MINIMAL_YAML}timezone: America/Montreal\n`).timezone).toBe("America/Montreal");
    expect(() => parseConfig(`${MINIMAL_YAML}timezone: Europe/Pariss\n`)).toThrow(/Fuseau horaire inconnu/);
  });
  test("allowedOrigins: none by default, exact origins only", () => {
    expect(parseConfig(MINIMAL_YAML).allowedOrigins).toEqual([]);
    expect(parseConfig(`${MINIMAL_YAML}allowedOrigins: ["https://alicia.tailnet.ts.net"]\n`).allowedOrigins).toEqual([
      "https://alicia.tailnet.ts.net",
    ]);
    expect(() => parseConfig(`${MINIMAL_YAML}allowedOrigins: ["https://alicia.tailnet.ts.net/"]\n`)).toThrow(/Origine invalide/);
    expect(() => parseConfig(`${MINIMAL_YAML}allowedOrigins: ["*"]\n`)).toThrow(/Origine invalide/);
    expect(() => parseConfig(`${MINIMAL_YAML}allowedOrigins: ["ftp://alicia.lan"]\n`)).toThrow(/Origine invalide/);
  });
  test("allowedOrigins: the message explains the exact form (lowercase, no default port)", () => {
    expect(() => parseConfig(`${MINIMAL_YAML}allowedOrigins: ["https://Alicia.lan"]\n`)).toThrow(/en minuscules/);
    expect(() => parseConfig(`${MINIMAL_YAML}allowedOrigins: ["https://alicia.lan:443"]\n`)).toThrow(/sans port par défaut/);
  });
});

describe("readAuthentication", () => {
  test("subscription: reads CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(readAuthentication("subscription", { CLAUDE_CODE_OAUTH_TOKEN: "token" })).toEqual({
      mode: "subscription", token: "token",
    });
  });
  test("API key: reads ANTHROPIC_API_KEY", () => {
    expect(readAuthentication("api_key", { ANTHROPIC_API_KEY: "key" })).toEqual({
      mode: "api_key", key: "key",
    });
  });
  test("missing secret: explicit message", () => {
    expect(() => readAuthentication("subscription", {})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
});
