import { describe, expect, test } from "vitest";
import { parseConfig, readAuthentication, readSecretKey, takeSecretKey } from "../src/config.ts";

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

const KEY = Buffer.alloc(32, 7).toString("base64");

/** The message of what `run` throws (fails the test when it does not throw). */
function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a throw");
}

describe("google config", () => {
  test("google is optional", () => {
    expect(parseConfig("people: [{ id: kevin, name: Kévin }]\nengine: { mode: subscription }").google).toBeUndefined();
    expect(parseConfig(
      "people: [{ id: kevin, name: Kévin }]\nengine: { mode: subscription }\ngoogle: { clientSecretFile: ./secrets/google.json }",
    ).google).toEqual({ clientSecretFile: "./secrets/google.json" });
    expect(() => parseConfig("people: [{ id: kevin, name: Kévin }]\nengine: { mode: subscription }\ngoogle: { clientSecretFile: \"\" }"))
      .toThrow();
  });

  test("ALICIA_SECRET_KEY: 32 bytes in base64", () => {
    expect(readSecretKey({ ALICIA_SECRET_KEY: KEY })).toEqual(Buffer.alloc(32, 7));
    // Its own memory, not a slice of Node's shared pool: the caller can wipe it without leaving a copy around.
    const key = readSecretKey({ ALICIA_SECRET_KEY: KEY });
    expect(key.byteOffset).toBe(0);
    expect(key.buffer.byteLength).toBe(32);
    expect(readSecretKey({ ALICIA_SECRET_KEY: ` ${KEY}\n` })).toEqual(Buffer.alloc(32, 7));
  });

  test("a missing or malformed key is refused without echoing it", () => {
    expect(() => readSecretKey({})).toThrow(/ALICIA_SECRET_KEY manquant/);
    expect(() => readSecretKey({ ALICIA_SECRET_KEY: "  " })).toThrow(/ALICIA_SECRET_KEY manquant/);
    const short = Buffer.alloc(16, 1).toString("base64");
    expect(thrown(() => readSecretKey({ ALICIA_SECRET_KEY: short }))).toMatch(/32 octets/);
    expect(thrown(() => readSecretKey({ ALICIA_SECRET_KEY: short }))).toMatch(/44 caractères, finissant par =/);
    expect(thrown(() => readSecretKey({ ALICIA_SECRET_KEY: short }))).not.toContain(short);
    const garbage = "pas-du-base64-du-tout!";
    expect(thrown(() => readSecretKey({ ALICIA_SECRET_KEY: garbage }))).not.toContain("pas-du-base64");
    // Base64 with stray characters that Buffer.from would silently skip: refused too.
    expect(() => readSecretKey({ ALICIA_SECRET_KEY: `${KEY.slice(0, 20)}!${KEY.slice(20)}` })).toThrow(/32 octets/);
  });

  test("taking the key removes it from the environment: nothing started later can inherit it", () => {
    const env: Record<string, string | undefined> = { ALICIA_SECRET_KEY: KEY, PATH: "x" };
    expect(takeSecretKey(env)).toEqual(Buffer.alloc(32, 7));
    expect(env).toEqual({ PATH: "x" });
    // Refused, it is removed all the same.
    const bad: Record<string, string | undefined> = { ALICIA_SECRET_KEY: "court" };
    expect(() => takeSecretKey(bad)).toThrow(/32 octets/);
    expect(bad).toEqual({});
  });
});
