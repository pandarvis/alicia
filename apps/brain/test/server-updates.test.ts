import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { PairingService } from "../src/identity/pairing.ts";
import { createServer } from "../src/server/server.ts";
import { createChatDeps, createTestClock, createTestDb } from "./helpers.ts";

const dirs: string[] = [];
const servers: { close(): Promise<unknown> }[] = [];
const INSTALLER = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serverWith(updatesDir?: string) {
  const db = createTestDb();
  const time = createTestClock();
  const chat = createChatDeps(db, time.clock, new FakeEngine(() => []));
  const server = await createServer({
    pairing: new PairingService(db, time.clock),
    repository: chat.repository,
    version: "0.1.0",
    chat,
    ...(updatesDir !== undefined ? { updatesDir } : {}),
  });
  servers.push(server);
  return server;
}

/** A data folder like the brain's: the database next to the published versions. */
function publishedUpdates(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "alicia-updates-"));
  dirs.push(dataDir);
  const updatesDir = join(dataDir, "updates");
  mkdirSync(updatesDir);
  writeFileSync(join(updatesDir, "latest.yml"), "version: 0.2.0\npath: Alicia-Setup-0.2.0.exe\n");
  writeFileSync(join(updatesDir, "Alicia-Setup-0.2.0.exe"), INSTALLER);
  writeFileSync(join(updatesDir, ".hidden"), "secret");
  writeFileSync(join(dataDir, "alicia.db"), "database");
  return updatesDir;
}

describe("/updates/", () => {
  test("serves the published versions to anyone (no token); latest.yml is never cached", async () => {
    const app = await serverWith(publishedUpdates());
    const latest = await app.inject({ method: "GET", url: "/updates/latest.yml" });
    expect(latest.statusCode).toBe(200);
    expect(latest.body).toContain("version: 0.2.0");
    expect(latest.headers["cache-control"]).toBe("no-cache");
    const installer = await app.inject({ method: "GET", url: "/updates/Alicia-Setup-0.2.0.exe" });
    expect(installer.statusCode).toBe(200);
    expect(installer.rawPayload).toEqual(INSTALLER);
  });

  test("no listing, no hidden files, nothing outside the folder", async () => {
    const app = await serverWith(publishedUpdates());
    for (const url of [
      "/updates/", "/updates/.hidden", "/updates/../alicia.db", "/updates/..%2falicia.db", "/updates/%2e%2e/alicia.db",
      "/updates/..%5calicia.db", "/updates/..\\alicia.db", "/updates/sub/../../alicia.db",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).not.toBe(200);
      expect(response.body, url).not.toContain("database");
      expect(response.body, url).not.toContain("secret");
    }
  });

  test("HEAD gives the size without the body (electron-updater and download managers ask first)", async () => {
    const app = await serverWith(publishedUpdates());
    const head = await app.inject({ method: "HEAD", url: "/updates/Alicia-Setup-0.2.0.exe" });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(INSTALLER.length));
    expect(head.rawPayload).toHaveLength(0);
  });

  test("without an updates folder, the route does not exist", async () => {
    const app = await serverWith();
    expect((await app.inject({ method: "GET", url: "/updates/latest.yml" })).statusCode).toBe(404);
  });
});
