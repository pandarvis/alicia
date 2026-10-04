import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Person } from "@alicia/protocol";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { devices, pairingCodes } from "../db/schema.ts";
import type { Clock } from "../clock.ts";
import { findPerson } from "./people.ts";

const CODE_TTL_MS = 10 * 60_000;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const MAX_DRAWS = 20;

const drawRandomCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");

export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export type PairingResult =
  | { token: string; person: Person }
  | { error: "invalid_code" | "too_many_attempts" };

export interface AuthenticatedDevice {
  deviceId: string;
  person: Person;
}

/** A paired device, as shown by `alicia devices` (dates in ms). */
export interface Device {
  id: string;
  personId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export class PairingService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #drawCode: () => string;
  #failures: number[] = [];

  constructor(db: Db, clock: Clock, drawCode: () => string = drawRandomCode) {
    this.#db = db;
    this.#clock = clock;
    this.#drawCode = drawCode;
  }

  /** 6-digit code, valid for 10 minutes, single use. */
  generateCode(personId: string): string {
    if (findPerson(this.#db, personId) === undefined) {
      throw new Error(`Personne inconnue : ${personId}`);
    }
    const now = this.#clock();
    this.#db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, now)).run();
    // A code already pending (for anyone) is never reassigned: draw another one.
    for (let attempt = 0; attempt < MAX_DRAWS; attempt++) {
      const code = this.#drawCode();
      const result = this.#db
        .insert(pairingCodes)
        .values({ codeHash: hash(code), personId, expiresAt: now + CODE_TTL_MS })
        .onConflictDoNothing()
        .run();
      if (result.changes === 1) return code;
    }
    throw new Error("Impossible de générer un code d'appairage unique.");
  }

  redeem(code: string, deviceName: string): PairingResult {
    const now = this.#clock();
    this.#failures = this.#failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (this.#failures.length >= MAX_FAILURES) return { error: "too_many_attempts" };

    const row = this.#db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.codeHash, hash(code)))
      .get();
    if (row === undefined || row.expiresAt < now) {
      this.#failures.push(now);
      return { error: "invalid_code" };
    }
    this.#db.delete(pairingCodes).where(eq(pairingCodes.codeHash, row.codeHash)).run();

    const person = findPerson(this.#db, row.personId);
    if (person === undefined) return { error: "invalid_code" };

    const token = randomBytes(32).toString("base64url");
    this.#db
      .insert(devices)
      .values({
        id: randomUUID(),
        personId: person.id,
        name: deviceName,
        tokenHash: hash(token),
        createdAt: now,
      })
      .run();
    return { token, person };
  }

  /** Authenticates a token: returns the device and its person, and records the last visit. */
  authenticateDevice(token: string): AuthenticatedDevice | undefined {
    const device = this.#db
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, hash(token)))
      .get();
    if (device === undefined || device.revokedAt !== null) return undefined;
    const person = findPerson(this.#db, device.personId);
    if (person === undefined) return undefined;
    this.#db
      .update(devices)
      .set({ lastSeenAt: this.#clock() })
      .where(eq(devices.id, device.id))
      .run();
    return { deviceId: device.id, person };
  }

  authenticate(token: string): Person | undefined {
    return this.authenticateDevice(token)?.person;
  }

  /** True as long as the device exists and has not been revoked. */
  isActive(deviceId: string): boolean {
    const device = this.#db
      .select({ revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .get();
    return device !== undefined && device.revokedAt === null;
  }

  /** All devices, for every person, newest first. */
  listDevices(): Device[] {
    return this.#db
      .select({
        id: devices.id,
        personId: devices.personId,
        name: devices.name,
        createdAt: devices.createdAt,
        lastSeenAt: devices.lastSeenAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .orderBy(desc(devices.createdAt), desc(sql`rowid`))
      .all();
  }

  /** Revokes a device by id. True if an active device was just revoked. */
  revokeDevice(id: string): boolean {
    const result = this.#db
      .update(devices)
      .set({ revokedAt: this.#clock() })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
      .run();
    return result.changes === 1;
  }

  revoke(token: string): void {
    this.#db
      .update(devices)
      .set({ revokedAt: this.#clock() })
      .where(and(eq(devices.tokenHash, hash(token)), isNull(devices.revokedAt)))
      .run();
  }
}
