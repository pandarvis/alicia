import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Opens (or creates) the database and applies pending migrations. */
export function openDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export type Db = ReturnType<typeof openDb>;
