import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { MemoryStore } from "./store.ts";

export interface AliceMemory {
  key: string;
  text: string;
  pinned: boolean;
  createdAt: number;
  recallCount: number;
  lastRecalledAt: number | null;
}

export interface AliceRule {
  key: string;
  text: string;
  createdAt: number;
}

const ChromaRow = z.object({
  embedding_id: z.string(),
  text: z.string().nullable(),
  pinned: z.number().nullable(),
  created: z.number().nullable(),
  hits: z.number().nullable(),
  last_recalled: z.number().nullable(),
});

const RulesFile = z.object({
  regles: z.array(z.object({ id: z.string(), texte: z.string(), cree_le: z.string() })),
});

/** The API's limit on a memory text; longer old texts are not imported (nothing is silently altered). */
const MAX_TEXT_LENGTH = 1000;

/**
 * Reads the old Alice's Chroma database without Chroma itself. The old Alice may be running: the
 * database (and its -wal/-shm siblings) is copied to a temporary folder and only the copy is opened,
 * so the source folder is never written to. `now` stands in for a missing creation date.
 */
export function readAliceMemories(chromaPath: string, now: number = Date.now()): AliceMemory[] {
  const copyDir = mkdtempSync(join(tmpdir(), "alicia-chroma-"));
  try {
    const copy = join(copyDir, basename(chromaPath));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (suffix === "" || existsSync(chromaPath + suffix)) copyFileSync(chromaPath + suffix, copy + suffix);
    }
    return readChroma(copy, now);
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
}

function readChroma(chromaPath: string, now: number): AliceMemory[] {
  const db = new Database(chromaPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT e.embedding_id,
                MAX(CASE WHEN m.key = 'chroma:document' THEN m.string_value END) AS text,
                MAX(CASE WHEN m.key = 'pinned' THEN m.bool_value END) AS pinned,
                MAX(CASE WHEN m.key = 'created' THEN m.int_value END) AS created,
                MAX(CASE WHEN m.key = 'hits' THEN m.int_value END) AS hits,
                MAX(CASE WHEN m.key = 'last_recalled' THEN m.int_value END) AS last_recalled
         FROM embeddings e JOIN embedding_metadata m ON m.id = e.id
         GROUP BY e.id ORDER BY e.id`,
      )
      .all()
      .map((row) => ChromaRow.parse(row));
    return rows.flatMap((row) =>
      row.text === null || row.text.trim() === ""
        ? []
        : [{
            key: `alice:chroma:${row.embedding_id}`,
            text: row.text.trim(),
            pinned: row.pinned === 1,
            createdAt: row.created === null ? now : row.created * 1000,
            recallCount: row.hits ?? 0,
            lastRecalledAt: row.last_recalled === null ? null : row.last_recalled * 1000,
          }],
    );
  } finally {
    db.close();
  }
}

/** `now` stands in for a missing or unreadable creation date. */
export function readAliceRules(rulesPath: string, now: number = Date.now()): AliceRule[] {
  const file = RulesFile.parse(JSON.parse(readFileSync(rulesPath, "utf8")));
  return file.regles.map((rule) => {
    const created = Date.parse(rule.cree_le);
    return { key: `alice:rule:${rule.id}`, text: rule.texte.trim(), createdAt: Number.isNaN(created) ? now : created };
  });
}

export interface ImportReport {
  created: number;
  duplicates: number;
  /** Already imported by a previous run (same import key). */
  skipped: number;
  /** Not stored: the old text holds a secret, is empty, or is longer than the API allows. */
  refused: number;
}

/** Imports everything into the household (common) memory. Safe to run again: already imported keys are skipped. */
export async function importAlice(
  store: MemoryStore,
  source: { memories: readonly AliceMemory[]; rules: readonly AliceRule[] },
): Promise<ImportReport> {
  const report: ImportReport = { created: 0, duplicates: 0, skipped: 0, refused: 0 };
  const items = [
    ...source.rules.map((rule) => ({ ...rule, kind: "rule" as const, pinned: true, recallCount: 0, lastRecalledAt: null })),
    ...source.memories.map((memory) => ({ ...memory, kind: "fact" as const })),
  ];
  for (const item of items) {
    if (store.hasImportKey(item.key)) {
      report.skipped++;
      continue;
    }
    if (item.text.length > MAX_TEXT_LENGTH) {
      report.refused++;
      continue;
    }
    // The person id is irrelevant for the common scope: everything lands in the household memory.
    const result = await store.remember({
      personId: "import", scope: "common", kind: item.kind, text: item.text, source: "import", pinned: item.pinned,
      importKey: item.key, createdAt: item.createdAt, recallCount: item.recallCount, lastRecalledAt: item.lastRecalledAt,
    });
    if (result.status === "created") report.created++;
    else if (result.status === "duplicate") report.duplicates++;
    else report.refused++;
  }
  return report;
}
