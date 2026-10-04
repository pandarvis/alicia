import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

const DOSSIER_MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Ouvre (ou crée) la base et applique les migrations en attente. */
export function ouvrirBase(chemin: string) {
  const sqlite = new Database(chemin);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const base = drizzle({ client: sqlite, schema });
  migrate(base, { migrationsFolder: DOSSIER_MIGRATIONS });
  return base;
}

export type Base = ReturnType<typeof ouvrirBase>;
