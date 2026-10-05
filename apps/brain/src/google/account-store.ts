import { randomUUID } from "node:crypto";
import type { GoogleOwner } from "@alicia/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/open.ts";
import { googleAccounts } from "../db/schema.ts";
import { type TokenCipher, TokenDecryptError } from "./token-cipher.ts";

type Row = typeof googleAccounts.$inferSelect;

/** An account as the rest of the brain sees it: never its token. */
export interface GoogleAccount {
  id: string;
  /** "common" (household) or a person id. */
  owner: string;
  email: string;
  scopes: string[];
  status: Row["status"];
  createdAt: number;
  /** Last successful connection. */
  updatedAt: number;
}

export interface ConnectInput {
  /** The person connecting the account. */
  personId: string;
  owner: GoogleOwner;
  email: string;
  scopes: readonly string[];
  refreshToken: string;
}

export type ConnectResult =
  | { status: "created" | "updated"; account: GoogleAccount }
  | { status: "conflict" };

export interface RemovedAccount {
  account: GoogleAccount;
  /** Undefined when it could not be decrypted any more (nothing to revoke). */
  refreshToken: string | undefined;
}

const COMMON = "common";

function strip(row: Row): GoogleAccount {
  return {
    id: row.id,
    owner: row.owner,
    email: row.email,
    scopes: row.scopes.split(" ").filter((scope) => scope !== ""),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Authenticated data of a row's token: a ciphertext moved to another row (or owner) no longer decrypts. */
function tokenContext(id: string, owner: string): string {
  return `google-account:${id}:${owner}`;
}

/**
 * Google accounts, cloisonnés by construction: every method takes the person acting and only ever
 * reaches "common" accounts and that person's own. No parameter can name another person.
 */
export class GoogleAccountStore {
  readonly #db: Db;
  readonly #cipher: TokenCipher;
  readonly #clock: Clock;

  constructor(db: Db, cipher: TokenCipher, clock: Clock) {
    this.#db = db;
    this.#cipher = cipher;
    this.#clock = clock;
  }

  /** The rows a person may reach: the household's and their own. */
  #reach(personId: string) {
    return inArray(googleAccounts.owner, [COMMON, personId]);
  }

  #row(personId: string, id: string): Row | undefined {
    return this.#db.select().from(googleAccounts).where(and(eq(googleAccounts.id, id), this.#reach(personId))).get();
  }

  list(personId: string): GoogleAccount[] {
    return this.#db
      .select()
      .from(googleAccounts)
      .where(this.#reach(personId))
      .orderBy(asc(googleAccounts.owner), asc(googleAccounts.email))
      .all()
      .map(strip);
  }

  get(personId: string, id: string): GoogleAccount | undefined {
    const row = this.#row(personId, id);
    return row === undefined ? undefined : strip(row);
  }

  byEmail(personId: string, email: string): GoogleAccount | undefined {
    const row = this.#db
      .select()
      .from(googleAccounts)
      .where(and(eq(googleAccounts.email, normalizeEmail(email)), this.#reach(personId)))
      .get();
    return row === undefined ? undefined : strip(row);
  }

  /**
   * New account, or a reconnection of the same address with the same owner. Any other case is
   * someone else's account (or a change of owner): refused, the stored token is left untouched.
   */
  connect(input: ConnectInput): ConnectResult {
    if (input.personId === "" || input.personId === COMMON) throw new Error("A Google account is connected by a person");
    if (input.refreshToken === "") throw new Error("A Google account needs a refresh token");
    const owner = input.owner === "common" ? COMMON : input.personId;
    const email = normalizeEmail(input.email);
    const scopes = [...input.scopes].sort().join(" ");
    const now = this.#clock();
    return this.#db.transaction((tx) => {
      const existing = tx.select().from(googleAccounts).where(eq(googleAccounts.email, email)).get();
      if (existing === undefined) {
        const id = randomUUID();
        tx.insert(googleAccounts).values({
          id, owner, email, scopes, status: "connected", createdAt: now, updatedAt: now,
          refreshToken: this.#cipher.encrypt(input.refreshToken, tokenContext(id, owner)),
        }).run();
        return { status: "created", account: this.#mustGet(input.personId, id) };
      }
      if (existing.owner !== owner) return { status: "conflict" };
      tx.update(googleAccounts)
        .set({
          scopes, status: "connected", updatedAt: now,
          refreshToken: this.#cipher.encrypt(input.refreshToken, tokenContext(existing.id, owner)),
        })
        .where(eq(googleAccounts.id, existing.id))
        .run();
      return { status: "updated", account: this.#mustGet(input.personId, existing.id) };
    });
  }

  /** The refresh token, or undefined out of reach. Throws TokenDecryptError when it cannot be read back. */
  refreshTokenOf(personId: string, id: string): string | undefined {
    const row = this.#row(personId, id);
    return row === undefined ? undefined : this.#cipher.decrypt(row.refreshToken, tokenContext(row.id, row.owner));
  }

  /** Google refused the stored authorization: the app will offer « Reconnecter ». */
  markReconnect(personId: string, id: string): boolean {
    const { changes } = this.#db
      .update(googleAccounts)
      // updatedAt stays the last successful connection (shown as « connecté le … »).
      .set({ status: "reconnect" })
      .where(and(eq(googleAccounts.id, id), this.#reach(personId)))
      .run();
    return changes === 1;
  }

  /** Deletes the account; its token comes back for revocation (undefined when it cannot be read any more). */
  remove(personId: string, id: string): RemovedAccount | undefined {
    const row = this.#row(personId, id);
    if (row === undefined) return undefined;
    let refreshToken: string | undefined;
    try {
      refreshToken = this.#cipher.decrypt(row.refreshToken, tokenContext(row.id, row.owner));
    } catch (error) {
      if (!(error instanceof TokenDecryptError)) throw error;
    }
    this.#db.delete(googleAccounts).where(and(eq(googleAccounts.id, id), this.#reach(personId))).run();
    return { account: strip(row), refreshToken };
  }

  #mustGet(personId: string, id: string): GoogleAccount {
    const account = this.get(personId, id);
    if (account === undefined) throw new Error("Google account vanished right after being written");
    return account;
  }
}
