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
  test("applies the defaults", () => {
    const c = parseConfig(MINIMAL_YAML);
    expect(c.port).toBe(8780);
    expect(c.host).toBe("0.0.0.0");
    expect(c.timezone).toBe("Europe/Paris");
    expect(c.models).toEqual({ sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
    expect(c.people.map((p) => p.id)).toEqual(["kevin", "elodie"]);
  });
  test("rejects a config without any person", () => {
    expect(() => parseConfig("people: []\nengine: { mode: subscription }")).toThrow();
  });
  test("rejects an unknown engine mode", () => {
    expect(() => parseConfig("people: [{ id: kevin, name: K }]\nengine: { mode: free }")).toThrow();
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
