import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type Cipher, EncryptionUnavailableError, SessionStore } from "../src/main/session-store.ts";
import type { StoredSession } from "../src/shared/session.ts";

const SESSION: StoredSession = {
  serverUrl: "http://192.168.1.20:8780",
  // Deliberately not a palindrome, so the reversing fake cipher really hides it.
  token: "abcdefghij".repeat(4) + "klm",
  person: { id: "kevin", name: "Kévin" },
};

/** Reversible fake cipher: enough to prove the file is never plain JSON. */
const fakeCipher = (available = true): Cipher => ({
  isAvailable: () => available,
  encrypt: (text) => Buffer.from(text, "utf8").reverse(),
  decrypt: (data) => Buffer.from(data).reverse().toString("utf8"),
});

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});
const newPath = () => {
  dir = mkdtempSync(join(tmpdir(), "alicia-desktop-"));
  return join(dir, "session.bin");
};

describe("SessionStore", () => {
  test("no file: no session", () => {
    expect(new SessionStore(newPath(), fakeCipher()).load()).toBeNull();
  });

  test("save then load round-trips, and the token never hits the disk in clear", () => {
    const path = newPath();
    const store = new SessionStore(path, fakeCipher());
    store.save(SESSION);
    expect(store.load()).toEqual(SESSION);
    expect(readFileSync(path).toString("utf8")).not.toContain(SESSION.token);
  });

  test("save is atomic: no temporary file is left behind and it can be overwritten", () => {
    const path = newPath();
    const store = new SessionStore(path, fakeCipher());
    store.save(SESSION);
    store.save({ ...SESSION, person: { id: "elodie", name: "Élodie" } });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readdirSync(dirname(path))).toEqual(["session.bin"]);
    expect(store.load()?.person.id).toBe("elodie");
  });

  test("a refused save keeps the previous session intact", () => {
    const path = newPath();
    new SessionStore(path, fakeCipher()).save(SESSION);
    expect(() => {
      new SessionStore(path, fakeCipher(false)).save({ ...SESSION, person: { id: "elodie", name: "Élodie" } });
    }).toThrow();
    expect(new SessionStore(path, fakeCipher()).load()).toEqual(SESSION);
  });

  test("clear removes the session", () => {
    const store = new SessionStore(newPath(), fakeCipher());
    store.save(SESSION);
    store.clear();
    expect(store.load()).toBeNull();
  });

  test("corrupted or tampered file: no session instead of a crash", () => {
    const path = newPath();
    writeFileSync(path, "garbage");
    expect(new SessionStore(path, fakeCipher()).load()).toBeNull();
  });

  test("refuses to save when OS encryption is unavailable", () => {
    expect(() => {
      new SessionStore(newPath(), fakeCipher(false)).save(SESSION);
    }).toThrow(EncryptionUnavailableError);
  });
});
