import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, type PathLike, type RmOptions, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildApplication } from "../src/application.ts";
import { AttachmentStore, PENDING_TTL_MS } from "../src/attachments/store.ts";
import { parseConfig } from "../src/config.ts";
import { FakeEngine } from "../src/engine/fake-engine.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { createTempDir, createTestClock, createTestDb, PDF_BYTES } from "./helpers.ts";

/** Names (a folder, a file id) whose removal fails as on Windows when a file is still open (viewer, antivirus…). */
const locked = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync(path: PathLike, options?: RmOptions): void {
      const target = String(path);
      if ([...locked].some((name) => target.includes(name))) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: "EBUSY" });
      }
      fs.rmSync(path, options);
    },
  };
});

afterEach(() => {
  locked.clear();
  vi.restoreAllMocks();
});

/** A conversation folder whose conversation is gone, with one file in it. */
function orphanFolder(root: string): string {
  const id = randomUUID();
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, `${randomUUID()}.pdf`), PDF_BYTES);
  return id;
}

describe("a locked file never stops the startup upkeep", () => {
  test("sweep: a folder that cannot go yet is logged and left; the others go", () => {
    const root = createTempDir();
    const store = new AttachmentStore(createTestDb(), root, createTestClock().clock);
    const stuck = orphanFolder(root);
    const free = orphanFolder(root);
    locked.add(stuck);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(store.sweepOrphanFolders()).toBe(1);
    expect(errors).toHaveBeenCalledOnce();
    expect(existsSync(join(root, stuck))).toBe(true);
    expect(existsSync(join(root, free))).toBe(false);
    // Next startup, the file was closed: it goes.
    locked.clear();
    expect(store.sweepOrphanFolders()).toBe(1);
    expect(existsSync(join(root, stuck))).toBe(false);
  });

  test("purge: an expired upload whose file is locked is kept for the next purge; the others go", () => {
    const root = createTempDir();
    const time = createTestClock();
    const store = new AttachmentStore(createTestDb(), root, time.clock);
    const upload = (name: string) => {
      const result = store.upload("kevin", name, PDF_BYTES);
      if (result.status !== "stored") throw new Error(`refused: ${result.reason}`);
      return result.attachment;
    };
    const stuck = upload("ouvert.pdf");
    const free = upload("ferme.pdf");
    time.advance(PENDING_TTL_MS + 1);
    locked.add(stuck.id);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(store.purgePending()).toBe(1);
    expect(errors).toHaveBeenCalledOnce();
    expect(existsSync(join(root, "pending", `${stuck.id}.pdf`))).toBe(true);
    expect(existsSync(join(root, "pending", `${free.id}.pdf`))).toBe(false);
    // Expired, it can no longer be sent, even while it waits for its file to go.
    expect(store.pending("kevin", [stuck.id])).toBeUndefined();
    locked.clear();
    expect(store.purgePending()).toBe(1);
    expect(existsSync(join(root, "pending", `${stuck.id}.pdf`))).toBe(false);
  });

  test("the brain starts with a locked folder of a deleted conversation", async () => {
    const dir = createTempDir();
    const stuck = orphanFolder(join(dir, "attachments"));
    locked.add(stuck);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const config = parseConfig(`
dataDir: ${JSON.stringify(dir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
    const app = await buildApplication(config, new FakeEngine(() => []), { embedder: new FakeEmbedder() });
    try {
      expect((await app.server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect(errors).toHaveBeenCalledOnce();
      expect(existsSync(join(dir, "attachments", stuck))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
