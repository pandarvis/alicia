import { describe, expect, test } from "vitest";
import { TokenCipher, TokenDecryptError } from "../src/google/token-cipher.ts";

const KEY = Buffer.alloc(32, 3);
const TOKEN = "1//0g-refresh-token-value";

describe("token cipher", () => {
  test("round trip, never in clear, a fresh IV each time", () => {
    const cipher = new TokenCipher(KEY);
    const a = cipher.encrypt(TOKEN, "google-account:1:common");
    const b = cipher.encrypt(TOKEN, "google-account:1:common");
    expect(cipher.decrypt(a, "google-account:1:common")).toBe(TOKEN);
    expect(a.includes(Buffer.from(TOKEN))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  test("bound to its context: a ciphertext moved to another row or owner does not decrypt", () => {
    const cipher = new TokenCipher(KEY);
    const blob = cipher.encrypt(TOKEN, "google-account:1:kevin");
    expect(() => cipher.decrypt(blob, "google-account:1:elodie")).toThrow(TokenDecryptError);
    expect(() => cipher.decrypt(blob, "google-account:2:kevin")).toThrow(TokenDecryptError);
  });

  test("another key, a tampered, truncated or unknown-format blob: refused", () => {
    const blob = new TokenCipher(KEY).encrypt(TOKEN, "ctx");
    expect(() => new TokenCipher(Buffer.alloc(32, 4)).decrypt(blob, "ctx")).toThrow(TokenDecryptError);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => new TokenCipher(KEY).decrypt(tampered, "ctx")).toThrow(TokenDecryptError);
    const badTag = Buffer.from(blob);
    badTag[20] = (badTag[20] ?? 0) ^ 1;
    expect(() => new TokenCipher(KEY).decrypt(badTag, "ctx")).toThrow(TokenDecryptError);
    expect(() => new TokenCipher(KEY).decrypt(blob.subarray(0, 20), "ctx")).toThrow(TokenDecryptError);
    expect(() => new TokenCipher(KEY).decrypt(Buffer.alloc(0), "ctx")).toThrow(TokenDecryptError);
    const otherFormat = Buffer.from(blob);
    otherFormat[0] = 2;
    expect(() => new TokenCipher(KEY).decrypt(otherFormat, "ctx")).toThrow(TokenDecryptError);
  });

  test("the error never carries the token, the key or the context", () => {
    const blob = new TokenCipher(KEY).encrypt(TOKEN, "google-account:1:kevin");
    let message = "";
    try {
      new TokenCipher(Buffer.alloc(32, 4)).decrypt(blob, "google-account:1:kevin");
    } catch (error) {
      message = error instanceof Error ? `${error.name} ${error.message} ${String(error.cause)}` : "";
    }
    expect(message).toMatch(/decrypt/);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("kevin");
    expect(message).not.toContain(KEY.toString("base64"));
  });

  test("an empty token is never stored", () => {
    expect(() => new TokenCipher(KEY).encrypt("", "ctx")).toThrow();
  });

  test("the key must be 32 bytes, and the caller's buffer may be wiped afterwards", () => {
    expect(() => new TokenCipher(Buffer.alloc(16))).toThrow();
    const key = Buffer.alloc(32, 5);
    const cipher = new TokenCipher(key);
    const blob = cipher.encrypt(TOKEN, "ctx");
    key.fill(0);
    expect(cipher.decrypt(blob, "ctx")).toBe(TOKEN);
  });
});
