import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { googleAccounts } from "../src/db/schema.ts";
import { GoogleAccountStore } from "../src/google/account-store.ts";
import { TokenCipher, TokenDecryptError } from "../src/google/token-cipher.ts";
import { createTestClock, createTestDb, createTestGoogleAccounts } from "./helpers.ts";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function setup() {
  const db = createTestDb();
  const time = createTestClock();
  const store = createTestGoogleAccounts(db, time.clock);
  const connect = (personId: string, owner: "common" | "personal", email: string, refreshToken = `rt-${email}`) =>
    store.connect({ personId, owner, email, scopes: SCOPES, refreshToken });
  const idOf = (personId: string, email: string) => store.byEmail(personId, email)?.id ?? "";
  return { db, time, store, connect, idOf };
}

describe("google accounts store", () => {
  test("connect, list, token kept encrypted", () => {
    const { db, store, connect, time } = setup();
    const result = connect("kevin", "personal", "Kevin@Example.com");
    expect(result.status).toBe("created");
    const accounts = store.list("kevin");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({
      id: accounts[0]?.id, owner: "kevin", email: "kevin@example.com", scopes: SCOPES, status: "connected",
      createdAt: time.clock(), updatedAt: time.clock(),
    });
    expect(accounts[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    // The rest of the brain never sees the token.
    expect(Object.keys(accounts[0] ?? {})).not.toContain("refreshToken");
    const id = accounts[0]?.id ?? "";
    expect(store.refreshTokenOf("kevin", id)).toBe("rt-Kevin@Example.com");
    const row = db.select().from(googleAccounts).where(eq(googleAccounts.id, id)).get();
    expect(row?.refreshToken.includes(Buffer.from("rt-Kevin@Example.com"))).toBe(false);
  });

  test("cloisonnement: Élodie sees common and hers, never Kévin's personal account", () => {
    const { store, connect, idOf } = setup();
    connect("kevin", "common", "famille@example.com");
    connect("kevin", "personal", "kevin@example.com");
    connect("elodie", "personal", "elodie@example.com");
    expect(store.list("elodie").map((a) => a.email).sort()).toEqual(["elodie@example.com", "famille@example.com"]);
    expect(store.list("kevin").map((a) => a.email).sort()).toEqual(["famille@example.com", "kevin@example.com"]);

    const kevinId = idOf("kevin", "kevin@example.com");
    expect(kevinId).not.toBe("");
    expect(store.get("elodie", kevinId)).toBeUndefined();
    expect(store.byEmail("elodie", "kevin@example.com")).toBeUndefined();
    expect(store.byEmail("elodie", " KEVIN@example.com ")).toBeUndefined();
    expect(store.refreshTokenOf("elodie", kevinId)).toBeUndefined();
    expect(store.markReconnect("elodie", kevinId)).toBe(false);
    expect(store.remove("elodie", kevinId)).toBeUndefined();
    expect(store.get("kevin", kevinId)?.status).toBe("connected");
    expect(store.refreshTokenOf("kevin", kevinId)).toBe("rt-kevin@example.com");
  });

  test("Élodie tries every parameter to reach Kévin's account: nothing leaks, nothing changes", () => {
    const { store, connect, idOf } = setup();
    connect("kevin", "personal", "kevin@example.com", "rt-kevin");
    const kevinId = idOf("kevin", "kevin@example.com");
    // Every way of naming the account or its owner, through every method.
    for (const personId of ["elodie", "Elodie", "common", "", "elodie' OR '1'='1", "%"]) {
      expect(store.list(personId).map((a) => a.email), personId).not.toContain("kevin@example.com");
      for (const id of [kevinId, kevinId.toUpperCase(), ` ${kevinId}`, "%", "*"]) {
        expect(store.get(personId, id), `${personId} ${id}`).toBeUndefined();
        expect(store.refreshTokenOf(personId, id), `${personId} ${id}`).toBeUndefined();
        expect(store.markReconnect(personId, id), `${personId} ${id}`).toBe(false);
        expect(store.remove(personId, id), `${personId} ${id}`).toBeUndefined();
      }
      for (const email of ["kevin@example.com", "KEVIN@EXAMPLE.COM", "%@example.com", "kevin@%"]) {
        expect(store.byEmail(personId, email), `${personId} ${email}`).toBeUndefined();
      }
    }
    expect(store.get("kevin", kevinId)).toMatchObject({ owner: "kevin", status: "connected" });
    expect(store.refreshTokenOf("kevin", kevinId)).toBe("rt-kevin");
  });

  test("Élodie cannot take over Kévin's account by connecting the same address", () => {
    const { store, connect, idOf } = setup();
    connect("kevin", "personal", "kevin@example.com", "rt-kevin");
    expect(connect("elodie", "personal", "kevin@example.com", "rt-stolen")).toEqual({ status: "conflict" });
    expect(connect("elodie", "common", "kevin@example.com", "rt-stolen")).toEqual({ status: "conflict" });
    expect(connect("elodie", "personal", " Kevin@Example.COM ", "rt-stolen")).toEqual({ status: "conflict" });
    const kevinId = idOf("kevin", "kevin@example.com");
    expect(store.refreshTokenOf("kevin", kevinId)).toBe("rt-kevin");
    expect(store.list("elodie")).toEqual([]);
  });

  test("an empty refresh token is refused, nothing stored", () => {
    const { store, connect } = setup();
    expect(() => connect("kevin", "personal", "kevin@example.com", "")).toThrow();
    expect(store.list("kevin")).toEqual([]);
  });

  test("« common » is never a person connecting an account of their own", () => {
    const { store, connect } = setup();
    expect(() => connect("common", "personal", "x@example.com")).toThrow();
    expect(() => connect("", "common", "x@example.com")).toThrow();
    expect(store.list("kevin")).toEqual([]);
  });

  test("a household account cannot become someone's own, nor the reverse", () => {
    const { store, connect, idOf } = setup();
    connect("kevin", "common", "famille@example.com", "rt-f");
    connect("kevin", "personal", "kevin@example.com", "rt-k");
    expect(connect("kevin", "personal", "famille@example.com", "rt-x")).toEqual({ status: "conflict" });
    expect(connect("kevin", "common", "kevin@example.com", "rt-x")).toEqual({ status: "conflict" });
    expect(store.refreshTokenOf("kevin", idOf("kevin", "famille@example.com"))).toBe("rt-f");
    expect(store.refreshTokenOf("kevin", idOf("kevin", "kevin@example.com"))).toBe("rt-k");
  });

  test("reconnecting the same account replaces the token and clears the flag", () => {
    const { store, connect, time } = setup();
    const first = connect("kevin", "common", "famille@example.com", "rt-1");
    const id = first.status === "conflict" ? "" : first.account.id;
    expect(store.markReconnect("elodie", id)).toBe(true);
    expect(store.get("kevin", id)?.status).toBe("reconnect");
    // The flag keeps the date of the last successful connection.
    expect(store.get("kevin", id)?.updatedAt).toBe(first.status === "conflict" ? 0 : first.account.updatedAt);
    time.advance(60_000);
    const again = connect("elodie", "common", "famille@example.com", "rt-2");
    expect(again.status).toBe("updated");
    expect(store.get("kevin", id)).toMatchObject({ status: "connected", updatedAt: time.clock() });
    expect(store.refreshTokenOf("kevin", id)).toBe("rt-2");
    expect(store.list("kevin")).toHaveLength(1);
  });

  test("scopes are kept sorted, whatever order Google gave them in", () => {
    const { store } = setup();
    store.connect({
      personId: "kevin", owner: "personal", email: "kevin@example.com", refreshToken: "rt",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.events"],
    });
    expect(store.list("kevin")[0]?.scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  test("a token copied into another row does not decrypt there", () => {
    const { db, store, connect, idOf } = setup();
    connect("kevin", "personal", "kevin@example.com", "rt-kevin");
    connect("elodie", "personal", "elodie@example.com", "rt-elodie");
    const kevin = db.select().from(googleAccounts).where(eq(googleAccounts.email, "kevin@example.com")).get();
    db.update(googleAccounts).set({ refreshToken: kevin?.refreshToken ?? Buffer.alloc(0) })
      .where(eq(googleAccounts.email, "elodie@example.com")).run();
    const elodieId = idOf("elodie", "elodie@example.com");
    expect(() => store.refreshTokenOf("elodie", elodieId)).toThrow(TokenDecryptError);
    expect(() => store.refreshTokenOf("elodie", elodieId)).toThrow(/decrypt/);
  });

  test("a row moved to another owner does not decrypt either", () => {
    const { db, store, connect, idOf } = setup();
    connect("kevin", "personal", "kevin@example.com", "rt-kevin");
    db.update(googleAccounts).set({ owner: "elodie" }).where(eq(googleAccounts.email, "kevin@example.com")).run();
    expect(() => store.refreshTokenOf("elodie", idOf("elodie", "kevin@example.com"))).toThrow(TokenDecryptError);
  });

  test("another key (lost or changed): the token cannot be read, the account can still be removed", () => {
    const { db, connect, time } = setup();
    connect("kevin", "personal", "kevin@example.com", "rt-kevin");
    const other = new GoogleAccountStore(db, new TokenCipher(Buffer.alloc(32, 1)), time.clock);
    const id = other.byEmail("kevin", "kevin@example.com")?.id ?? "";
    expect(() => other.refreshTokenOf("kevin", id)).toThrow(TokenDecryptError);
    const removed = other.remove("kevin", id);
    expect(removed?.account.email).toBe("kevin@example.com");
    expect(removed).toHaveProperty("refreshToken", undefined);
    expect(other.list("kevin")).toEqual([]);
  });

  test("remove returns the token for revocation and deletes the row", () => {
    const { store, connect, idOf } = setup();
    connect("kevin", "common", "famille@example.com", "rt-f");
    const id = idOf("kevin", "famille@example.com");
    const removed = store.remove("elodie", id);
    expect(removed?.account.email).toBe("famille@example.com");
    expect(removed?.refreshToken).toBe("rt-f");
    expect(store.list("kevin")).toEqual([]);
    expect(store.remove("kevin", id)).toBeUndefined();
  });
});
