import { describe, expect, test } from "vitest";
import { devices, pairingCodes } from "../src/db/schema.ts";
import { hash, PairingService } from "../src/identity/pairing.ts";
import { createTestClock, createTestDb, ELODIE, KEVIN } from "./helpers.ts";

function createService() {
  const db = createTestDb();
  const time = createTestClock();
  return { db, time, service: new PairingService(db, time.clock) };
}

describe("PairingService", () => {
  test("the code is 6 digits and is redeemed for a token bound to the person", () => {
    const { service } = createService();
    const code = service.generateCode("kevin");
    expect(code).toMatch(/^\d{6}$/);
    const r = service.redeem(code, "PC Kévin");
    if ("error" in r) throw new Error(r.error);
    expect(r.person).toEqual(KEVIN);
    expect(r.token.length).toBeGreaterThanOrEqual(43);
    expect(service.authenticate(r.token)).toEqual(KEVIN);
  });

  test("the token is never stored in clear text", () => {
    const { db, service } = createService();
    const r = service.redeem(service.generateCode("kevin"), "PC");
    if ("error" in r) throw new Error(r.error);
    const row = db.select().from(devices).get();
    expect(row?.tokenHash).not.toBe(r.token);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a code can only be used once", () => {
    const { service } = createService();
    const code = service.generateCode("kevin");
    service.redeem(code, "PC");
    expect(service.redeem(code, "PC")).toEqual({ error: "invalid_code" });
  });

  test("a code expires after 10 minutes", () => {
    const { service, time } = createService();
    const code = service.generateCode("kevin");
    time.advance(10 * 60_000 + 1);
    expect(service.redeem(code, "PC")).toEqual({ error: "invalid_code" });
  });

  test("beyond 5 failures per minute, everything is rejected, even a valid code", () => {
    const { service, time } = createService();
    const good = service.generateCode("kevin");
    for (let i = 0; i < 5; i++) service.redeem("000000", "PC");
    expect(service.redeem(good, "PC")).toEqual({ error: "too_many_attempts" });
    time.advance(60_001);
    expect("token" in service.redeem(good, "PC")).toBe(true);
  });

  test("unknown person: refuses to generate a code", () => {
    const { service } = createService();
    expect(() => service.generateCode("unknown")).toThrow(/inconnue/);
  });

  test("a colliding code is never reassigned to another person", () => {
    const db = createTestDb();
    const time = createTestClock();
    db
      .insert(pairingCodes)
      .values({ codeHash: hash("111111"), personId: "elodie", expiresAt: time.clock() + 60_000 })
      .run();
    const draws = ["111111", "222222"];
    const service = new PairingService(db, time.clock, () => draws.shift() ?? "333333");

    expect(service.generateCode("kevin")).toBe("222222");

    const forElodie = service.redeem("111111", "Téléphone Élodie");
    if ("error" in forElodie) throw new Error(forElodie.error);
    expect(forElodie.person).toEqual(ELODIE);
    const forKevin = service.redeem("222222", "PC Kévin");
    if ("error" in forKevin) throw new Error(forKevin.error);
    expect(forKevin.person).toEqual(KEVIN);
  });

  test("if no unique code can be found, gives up", () => {
    const db = createTestDb();
    const time = createTestClock();
    db
      .insert(pairingCodes)
      .values({ codeHash: hash("111111"), personId: "elodie", expiresAt: time.clock() + 60_000 })
      .run();
    const service = new PairingService(db, time.clock, () => "111111");
    expect(() => service.generateCode("kevin")).toThrow(/unique/);
  });

  test("unknown or revoked token: no authentication", () => {
    const { service } = createService();
    expect(service.authenticate("x".repeat(43))).toBeUndefined();
    const r = service.redeem(service.generateCode("kevin"), "PC");
    if ("error" in r) throw new Error(r.error);
    service.revoke(r.token);
    expect(service.authenticate(r.token)).toBeUndefined();
  });
});

describe("PairingService — device management", () => {
  function pair(service: PairingService, personId: string, name: string): string {
    const r = service.redeem(service.generateCode(personId), name);
    if ("error" in r) throw new Error(r.error);
    return r.token;
  }

  test("lists the devices of every person, newest first", () => {
    const { service, time } = createService();
    const start = time.clock();
    pair(service, "kevin", "PC Kévin");
    time.advance(1000);
    const tabletToken = pair(service, "elodie", "Tablette");
    time.advance(1000);
    service.authenticate(tabletToken);

    const list = service.listDevices();
    expect(list.map((d) => [d.personId, d.name])).toEqual([
      ["elodie", "Tablette"],
      ["kevin", "PC Kévin"],
    ]);
    expect(list[0]).toMatchObject({ createdAt: start + 1000, lastSeenAt: start + 2000, revokedAt: null });
    expect(list[1]).toMatchObject({ createdAt: start, lastSeenAt: null, revokedAt: null });
    expect(list[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("authenticateDevice returns the device and the person; isActive follows revocation by id", () => {
    const { service, time } = createService();
    const token = pair(service, "kevin", "PC");
    const auth = service.authenticateDevice(token);
    expect(auth?.person).toEqual(KEVIN);
    const id = auth?.deviceId ?? "";
    expect(service.listDevices()[0]?.id).toBe(id);
    expect(service.isActive(id)).toBe(true);

    time.advance(5000);
    expect(service.revokeDevice(id)).toBe(true);
    expect(service.isActive(id)).toBe(false);
    expect(service.authenticateDevice(token)).toBeUndefined();
    expect(service.authenticate(token)).toBeUndefined();
    expect(service.listDevices()[0]?.revokedAt).toBe(time.clock());
  });

  test("revoking an unknown or already revoked device returns false and changes nothing", () => {
    const { service, time } = createService();
    const token = pair(service, "kevin", "PC");
    const id = service.authenticateDevice(token)?.deviceId ?? "";
    expect(service.revokeDevice("unknown")).toBe(false);
    expect(service.isActive("unknown")).toBe(false);
    expect(service.revokeDevice(id)).toBe(true);
    const revokedAt = service.listDevices()[0]?.revokedAt;
    time.advance(1000);
    expect(service.revokeDevice(id)).toBe(false);
    expect(service.listDevices()[0]?.revokedAt).toBe(revokedAt);
  });
});
