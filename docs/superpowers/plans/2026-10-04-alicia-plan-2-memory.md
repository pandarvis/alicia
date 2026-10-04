# Alicia — Plan 2 : la mémoire — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alicia se souvient. Elle a une mémoire durable commune à la famille et personnelle à chacun, la cherche elle-même (mots-clés + sens), retient d'office ce qui compte, se corrige et oublie sur demande, voit en permanence une fiche (règles de la maison + souvenirs épinglés), et récupère ce que savait l'ancienne Alice.

**Architecture:** Une table SQLite `memories` (texte, portée, type, épinglé, vecteur) avec un index plein texte FTS5 maintenu par triggers. Les vecteurs sont calculés **en local** par un modèle multilingue (multilingual-e5-small via `@huggingface/transformers`) derrière une interface `Embedder` (un `FakeEmbedder` déterministe sert aux tests). La recherche fusionne le classement FTS5 et le classement par similarité (calculée en JavaScript : quelques milliers de souvenirs au plus) par *reciprocal rank fusion*. Les outils mémoire sont les **premiers outils** d'Alicia : une abstraction `ToolDefinition` dans la couche moteur, convertie en serveur MCP in-process du SDK (`createSdkMcpServer`) ; les outils sont instanciés **par requête et liés à la personne qui parle** (cloisonnement par construction). Une API HTTP `/memories` prépare l'écran « Souvenirs » (plan suivant).

**Tech Stack:** Node 22, TypeScript ~6.0.3 strict, Drizzle + better-sqlite3 (FTS5 intégré), `@huggingface/transformers` (ONNX, CPU), Zod 4, Vitest 5, `@anthropic-ai/claude-agent-sdk` 0.3.288 (`tool`, `createSdkMcpServer`).

**Spec :** `docs/superpowers/specs/2026-10-04-alicia-socle-design.md`, section « Mémoire ».

**Écarts assumés par rapport à la spec :**
- Pas de `sqlite-vec` : la similarité est calculée en JavaScript sur les vecteurs stockés en BLOB. Pour une mémoire familiale (centaines, quelques milliers de souvenirs, vecteurs de 384 dimensions), c'est l'affaire de quelques millisecondes et ça évite une extension native de plus sur le Pi et le Mac mini.
- `memory_forget` fait un **oubli doux** (date d'oubli, purge définitive après 30 jours) au lieu d'une confirmation : les cartes de confirmation arrivent avec le plan 3 (outils). Un oubli erroné reste ainsi récupérable.

**Hors de ce plan :** l'écran « Souvenirs » dans l'app (plan suivant, qui consommera l'API HTTP d'ici), les skills (`ranger-un-souvenir`, plan 3), la carte de confirmation.

---

## Conventions (à lire avant la tâche 1)

- **Code en anglais** (identifiants, fichiers, commentaires, tests). **Textes vus par la famille en français** : messages des outils renvoyés à Alicia, consignes du prompt, erreurs HTTP lisibles.
- Imports relatifs avec extension `.ts`. Champs privés `#champ`, pas de propriétés de paramètres, pas d'`enum`.
- TypeScript strict maximal ; pas d'`any`, pas d'assertion de type dans `src/`, pas de règle de lint désactivée.
- Le temps est injecté (`Clock`). Les vecteurs sont injectés (`Embedder`) : **aucun test automatique ne télécharge le modèle**.
- Commits petits, en anglais, terminés par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Jamais `git add -A`** : ajouter les fichiers par chemin.
- Ne jamais toucher `apps/brain/.env`, `apps/brain/alicia.config.yaml`, `apps/brain/data/` (le cerveau réel de Kévin peut tourner sur le port 8780 : les tests utilisent le port 0).

## Structure des fichiers

```
packages/protocol/src/memory.ts          kinds, scopes, schémas HTTP mémoire
apps/brain/src/
├─ db/schema.ts                          + table memories, + index conversations/messages
├─ drizzle/000N_*.sql                    migration générée + migration personnalisée FTS5
├─ memory/embedder.ts                    interface Embedder, toBlob/fromBlob, cosine
├─ memory/fake-embedder.ts               vecteurs déterministes (sac de mots haché)
├─ memory/transformers-embedder.ts       multilingual-e5-small en local
├─ memory/ranking.ts                     ftsQuery, fuse (RRF) — fonctions pures
├─ memory/store.ts                       MemoryStore : remember/search/update/forget/list/sheet
├─ memory/sheet.ts                       fiche permanente (budget)
├─ memory/tools.ts                       outils mémoire liés à une personne
├─ memory/import-alice.ts                lecture Chroma + règles JSON de l'ancienne Alice
├─ engine/tools.ts                       ToolDefinition, defineTool
├─ engine/sdk-engine.ts                  + serveur MCP in-process
├─ engine/fake-engine.ts                 + scénarios asynchrones (appels d'outils)
├─ agent/system-prompt.ts                + guide mémoire + fiche
├─ conversations/chat-service.ts         + outils et fiche par requête
├─ server/memory-routes.ts               GET/POST/PATCH/DELETE /memories
└─ application.ts, cli.ts                + embedder, purge, commande import-alice
apps/desktop/src/renderer/src/lib/tool-labels.ts   libellés français des outils
```

---

### Task 1: Le schéma de la mémoire

**Files:**
- Modify: `apps/brain/src/db/schema.ts`
- Create (générés) : `apps/brain/drizzle/0001_*.sql`, `apps/brain/drizzle/0002_memories_fts.sql` (+ `meta/`)
- Create: `packages/protocol/src/memory.ts` ; Modify: `packages/protocol/src/index.ts`
- Modify: `apps/brain/src/config.ts` (l'identifiant `common` est réservé)
- Test: `apps/brain/test/memory-schema.test.ts`, `apps/brain/test/config.test.ts`, `packages/protocol/test/protocol.test.ts`

- [ ] **Step 1: Types partagés (test d'abord)**

Ajouter à `packages/protocol/test/protocol.test.ts` :
```ts
import { MEMORY_KINDS, MemoryPatch, MemorySummary } from "../src/index.ts";

describe("memory", () => {
  test("five kinds", () => {
    expect(MEMORY_KINDS).toEqual(["rule", "preference", "habit", "fact", "event"]);
  });
  test("summary", () => {
    expect(MemorySummary.safeParse({
      id: "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", scope: "personal", kind: "preference", text: "Aime les lasagnes",
      pinned: false, createdAt: "2026-10-04T13:30:00.000Z", updatedAt: "2026-10-04T13:30:00.000Z", recallCount: 2,
    }).success).toBe(true);
  });
  test("patch is strict and bounded", () => {
    expect(MemoryPatch.safeParse({ pinned: true }).success).toBe(true);
    expect(MemoryPatch.safeParse({ text: "" }).success).toBe(false);
    expect(MemoryPatch.safeParse({ scope: "elodie" }).success).toBe(false);
    expect(MemoryPatch.safeParse({ admin: true }).success).toBe(false);
  });
});
```

`packages/protocol/src/memory.ts` :
```ts
import { z } from "zod";

export const MEMORY_KINDS = ["rule", "preference", "habit", "fact", "event"] as const;
export const MemoryKind = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** Seen from the person asking: their own memories are "personal", the household's are "common". */
export const MemoryScope = z.enum(["common", "personal"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

const count = z.number().int().nonnegative();
const memoryText = z.string().trim().min(1).max(1000);

export const MemorySummary = z.object({
  id: z.uuid(),
  scope: MemoryScope,
  kind: MemoryKind,
  text: z.string(),
  pinned: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  recallCount: count,
});
export type MemorySummary = z.infer<typeof MemorySummary>;

export const MemoryCreate = z.strictObject({
  text: memoryText,
  kind: MemoryKind,
  scope: MemoryScope,
  pinned: z.boolean().optional(),
});
export type MemoryCreate = z.infer<typeof MemoryCreate>;

export const MemoryPatch = z.strictObject({
  text: memoryText.optional(),
  kind: MemoryKind.optional(),
  scope: MemoryScope.optional(),
  pinned: z.boolean().optional(),
});
export type MemoryPatch = z.infer<typeof MemoryPatch>;
```
Ajouter `export * from "./memory.ts";` dans `packages/protocol/src/index.ts`. Run `pnpm --filter @alicia/protocol test` → PASS.

- [ ] **Step 2: Réserver `common` (test d'abord)**

Dans `apps/brain/test/config.test.ts` :
```ts
test("'common' is reserved and can't be a person id", () => {
  expect(() => parseConfig("people: [{ id: common, name: Tous }]\nengine: { mode: subscription }")).toThrow(/common/);
});
```
Dans `apps/brain/src/config.ts`, sur le champ `people` du schéma :
```ts
  people: z.array(Person).min(1).refine((list) => list.every((p) => p.id !== "common"), {
    message: "« common » est réservé à la mémoire commune : choisis un autre identifiant.",
  }),
```

- [ ] **Step 3: Écrire le test du schéma**

`apps/brain/test/memory-schema.test.ts` :
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { memories } from "../src/db/schema.ts";
import { createTestDb } from "./helpers.ts";

function insert(db: ReturnType<typeof createTestDb>, text: string, scope = "common") {
  const now = Date.UTC(2026, 9, 4);
  const id = randomUUID();
  db.insert(memories).values({
    id, scope, kind: "fact", text, pinned: false, source: "manual",
    embedding: Buffer.alloc(4), embeddingModel: "test", createdAt: now, updatedAt: now,
  }).run();
  return id;
}

const ftsIds = (db: ReturnType<typeof createTestDb>, match: string) =>
  db.$client
    .prepare("SELECT m.id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ?")
    .all(match)
    .map((row) => (row as { id: string }).id);

describe("memories table + FTS5", () => {
  test("full-text index follows inserts, updates and deletes", () => {
    const db = createTestDb();
    const id = insert(db, "Kévin adore les lasagnes");
    expect(ftsIds(db, "lasagnes")).toEqual([id]);
    db.$client.prepare("UPDATE memories SET text = 'Kévin adore les pizzas' WHERE id = ?").run(id);
    expect(ftsIds(db, "lasagnes")).toEqual([]);
    expect(ftsIds(db, "pizzas")).toEqual([id]);
    db.$client.prepare("DELETE FROM memories WHERE id = ?").run(id);
    expect(ftsIds(db, "pizzas")).toEqual([]);
  });

  test("accents are ignored by the full-text search", () => {
    const db = createTestDb();
    const id = insert(db, "Son plat préféré : la tartiflette");
    expect(ftsIds(db, "prefere")).toEqual([id]);
  });

  test("import_key is unique", () => {
    const db = createTestDb();
    const now = 0;
    const row = {
      scope: "common", kind: "fact" as const, text: "x", pinned: false, source: "import" as const,
      importKey: "alice:1", embedding: Buffer.alloc(4), embeddingModel: "t", createdAt: now, updatedAt: now,
    };
    db.insert(memories).values({ id: randomUUID(), ...row }).run();
    expect(() => db.insert(memories).values({ id: randomUUID(), ...row }).run()).toThrow(/UNIQUE/);
  });
});
```
(`createTestDb` est l'aide existante de `apps/brain/test/helpers.ts` qui ouvre une base en mémoire avec Kévin et Élodie ; adapter le nom s'il diffère.)

Run: `pnpm --filter @alicia/brain test memory-schema` → FAIL.

- [ ] **Step 4: Schéma Drizzle**

Dans `apps/brain/src/db/schema.ts`, importer `blob` et `index` de `drizzle-orm/sqlite-core`, et `MEMORY_KINDS` de `@alicia/protocol`, puis ajouter :
```ts
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    /** "common" (household) or a person id. */
    scope: text("scope").notNull(),
    kind: text("kind", { enum: MEMORY_KINDS }).notNull(),
    text: text("text").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ["conversation", "manual", "import"] }).notNull(),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** Idempotent imports (e.g. "alice:chroma:<id>"). */
    importKey: text("import_key").unique(),
    /** Float32 vector, little-endian. */
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: integer("last_recalled_at"),
    /** Soft delete: purged for good after 30 days. */
    forgottenAt: integer("forgotten_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("memories_scope_idx").on(table.scope, table.forgottenAt)],
);
```
Ajouter aussi les index notés aux relectures du plan 1 sur les tables existantes (troisième argument de `sqliteTable`) :
- `conversations` : `index("conversations_person_updated_idx").on(table.personId, table.updatedAt)`
- `messages` : `index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)`

- [ ] **Step 5: Migrations**

Run: `pnpm --filter @alicia/brain migrations` → génère `drizzle/0001_<nom>.sql` (table + index).
Run: `cd apps/brain && pnpm exec drizzle-kit generate --custom --name memories_fts` → crée un fichier SQL vide `drizzle/0002_memories_fts.sql` ; y écrire :
```sql
CREATE VIRTUAL TABLE `memories_fts` USING fts5(text, content='memories', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `memories_fts_insert` AFTER INSERT ON `memories` BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_delete` AFTER DELETE ON `memories` BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_update` AFTER UPDATE OF text ON `memories` BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
```

- [ ] **Step 6: Lancer les tests et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → PASS. Vérifier qu'une base existante migre : copier la base de Kévin n'est **pas** autorisé ; à la place, créer une base avec le schéma du plan 1 (checkout de `be9a468` dans un dossier temporaire n'est pas nécessaire) — il suffit de constater que les migrations `0000` → `0002` s'appliquent dans l'ordre sur une base vide (test ci-dessus) : Drizzle applique les migrations manquantes au démarrage.
```bash
git add packages/protocol/src/memory.ts packages/protocol/src/index.ts packages/protocol/test/protocol.test.ts apps/brain/src/db/schema.ts apps/brain/src/config.ts apps/brain/test/config.test.ts apps/brain/test/memory-schema.test.ts apps/brain/drizzle
git commit -m "feat(brain): memories table with FTS5 index, conversation/message indexes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Les vecteurs (embeddings)

**Files:**
- Create: `apps/brain/src/memory/embedder.ts`, `apps/brain/src/memory/fake-embedder.ts`, `apps/brain/src/memory/transformers-embedder.ts`
- Test: `apps/brain/test/embedder.test.ts`

- [ ] **Step 1: Installer**

Run: `pnpm --filter @alicia/brain add @huggingface/transformers` (dernière version). Si pnpm bloque des scripts de build (`onnxruntime-node`, `sharp`, `protobufjs`), les autoriser via `pnpm approve-builds` (entrée `allowBuilds` dans `pnpm-workspace.yaml`).

- [ ] **Step 2: Écrire les tests**

`apps/brain/test/embedder.test.ts` :
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cosine, fromBlob, toBlob } from "../src/memory/embedder.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { TransformersEmbedder } from "../src/memory/transformers-embedder.ts";

describe("vector helpers", () => {
  test("blob round-trip", () => {
    const v = new Float32Array([0.5, -1, 2.25]);
    expect(Array.from(fromBlob(toBlob(v)))).toEqual([0.5, -1, 2.25]);
  });
  test("cosine of normalized vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });
});

describe("FakeEmbedder", () => {
  test("deterministic, normalized, shared words → closer", async () => {
    const embedder = new FakeEmbedder();
    const [a, b, c] = await embedder.embed(
      ["Kévin adore les lasagnes", "les lasagnes de Kévin", "réunion de parents d'élèves"], "passage",
    );
    if (a === undefined || b === undefined || c === undefined) throw new Error("missing vectors");
    expect(a).toHaveLength(embedder.dimensions);
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect(Array.from((await embedder.embed(["Kévin adore les lasagnes"], "query"))[0] ?? [])).toEqual(Array.from(a));
  });
});

// Downloads ~120 MB the first time: opt-in only (ALICIA_REAL_EMBEDDINGS=1).
describe.skipIf(process.env["ALICIA_REAL_EMBEDDINGS"] !== "1")("TransformersEmbedder (real model)", () => {
  test("a question finds the related memory", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "alicia-models-"));
    try {
      const embedder = new TransformersEmbedder(cacheDir);
      const [lasagna, meeting] = await embedder.embed(
        ["Le plat préféré de Kévin, ce sont les lasagnes.", "Réunion parents-profs jeudi à 18 h."], "passage",
      );
      const [question] = await embedder.embed(["Qu'est-ce que Kévin aime manger ?"], "query");
      if (lasagna === undefined || meeting === undefined || question === undefined) throw new Error("missing vectors");
      expect(lasagna).toHaveLength(384);
      expect(cosine(question, lasagna)).toBeGreaterThan(cosine(question, meeting));
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 300_000);
});
```

Run: `pnpm --filter @alicia/brain test embedder` → FAIL.

- [ ] **Step 3: Écrire les modules**

`apps/brain/src/memory/embedder.ts` :
```ts
/** Turns texts into normalized vectors. "query" and "passage" may be encoded differently (e5 prefixes). */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  // Copy: the Buffer's offset may not be 4-byte aligned.
  const bytes = new Uint8Array(blob);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

/** Dot product: equals cosine similarity for normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function normalize(vector: Float32Array): Float32Array {
  const norm = Math.sqrt(cosine(vector, vector));
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

/** Lowercase, accent-free words of 2+ letters: shared by the fake embedder and the FTS query builder. */
export function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);
}
```

`apps/brain/src/memory/fake-embedder.ts` :
```ts
import { type Embedder, normalize, words } from "./embedder.ts";

const DIMENSIONS = 64;

/** FNV-1a 32-bit. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Deterministic bag-of-words vectors for tests: texts sharing words are close. Never downloads anything. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-bag-of-words-64";
  readonly dimensions = DIMENSIONS;

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Float32Array(DIMENSIONS);
        for (const word of words(text)) {
          const slot = hash(word) % DIMENSIONS;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        return normalize(vector);
      }),
    );
  }
}
```

`apps/brain/src/memory/transformers-embedder.ts` :
```ts
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import type { Embedder } from "./embedder.ts";

const MODEL = "Xenova/multilingual-e5-small";
const DIMENSIONS = 384;

/**
 * Local multilingual embeddings (ONNX on CPU): nothing leaves the house, no quota used.
 * The model (~120 MB) is downloaded once into `cacheDir` on first use.
 */
export class TransformersEmbedder implements Embedder {
  readonly model = MODEL;
  readonly dimensions = DIMENSIONS;
  readonly #cacheDir: string;
  #extractor: Promise<FeatureExtractionPipeline> | null = null;

  constructor(cacheDir: string) {
    this.#cacheDir = cacheDir;
  }

  async embed(texts: readonly string[], kind: "query" | "passage"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.#load();
    // e5 expects these prefixes.
    const output = await extractor(texts.map((text) => `${kind}: ${text}`), { pooling: "mean", normalize: true });
    const data = Float32Array.from(output.data);
    return texts.map((_, i) => data.slice(i * DIMENSIONS, (i + 1) * DIMENSIONS));
  }

  #load(): Promise<FeatureExtractionPipeline> {
    if (this.#extractor === null) {
      env.cacheDir = this.#cacheDir;
      this.#extractor = pipeline("feature-extraction", MODEL, { dtype: "q8" });
    }
    return this.#extractor;
  }
}
```
Vérifier les types réels de `@huggingface/transformers` installé (nom `FeatureExtractionPipeline`, forme de `output.data`, option `dtype`) et aligner le code sans `any` ni assertion. Si `pipeline()` renvoie un type union trop large, typer `#load` à partir de la valeur retournée (`ReturnType`) plutôt que d'asserter.

- [ ] **Step 4: Tests puis vérification réelle (une fois, manuelle)**

Run: `pnpm --filter @alicia/brain test embedder && pnpm typecheck && pnpm lint` → PASS (le test réel est sauté).
Run une fois : `cd apps/brain && ALICIA_REAL_EMBEDDINGS=1 pnpm exec vitest run test/embedder.test.ts` → le test réel passe (télécharge le modèle dans un dossier temporaire, supprimé ensuite). Noter le temps de chargement et d'un `embed` dans le rapport.

- [ ] **Step 5: Commit**

```bash
git add apps/brain/package.json pnpm-lock.yaml pnpm-workspace.yaml apps/brain/src/memory/embedder.ts apps/brain/src/memory/fake-embedder.ts apps/brain/src/memory/transformers-embedder.ts apps/brain/test/embedder.test.ts
git commit -m "feat(brain): local multilingual embeddings behind an Embedder interface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Classement hybride (fonctions pures)

**Files:**
- Create: `apps/brain/src/memory/ranking.ts`
- Test: `apps/brain/test/ranking.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/brain/test/ranking.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { ftsQuery, fuse } from "../src/memory/ranking.ts";

describe("ftsQuery", () => {
  test("quotes accent-free words and ORs them", () => {
    expect(ftsQuery("Quel est son plat préféré ?")).toBe('"quel" OR "est" OR "son" OR "plat" OR "prefere"');
  });
  test("neutralizes FTS5 syntax", () => {
    expect(ftsQuery('lasagnes" OR * NEAR(')).toBe('"lasagnes" OR "or" OR "near"');
  });
  test("nothing searchable → null", () => {
    expect(ftsQuery("? !")).toBeNull();
  });
});

describe("fuse (reciprocal rank fusion)", () => {
  test("items ranked well in both lists come first", () => {
    expect(fuse([["a", "b", "c"], ["b", "a", "d"]])).toEqual(["a", "b", "c", "d"]);
  });
  test("an item present in one list only still counts", () => {
    expect(fuse([["x"], []])).toEqual(["x"]);
  });
});
```

Run: FAIL.

- [ ] **Step 2: Écrire le module**

`apps/brain/src/memory/ranking.ts` :
```ts
import { words } from "./embedder.ts";

const RRF_K = 60;

/** FTS5 query from free text: each word quoted (no operator injection), any word may match. */
export function ftsQuery(text: string): string | null {
  const unique = [...new Set(words(text))];
  return unique.length === 0 ? null : unique.map((word) => `"${word}"`).join(" OR ");
}

/** Reciprocal rank fusion of several ranked id lists; ties keep first-seen order. */
export function fuse(lists: readonly (readonly string[])[]): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
```
(`Array.prototype.sort` est stable : à score égal, l'ordre d'insertion est conservé, d'où `["a","b","c","d"]`.)

- [ ] **Step 3: Tests puis commit**

Run: `pnpm --filter @alicia/brain test ranking && pnpm typecheck && pnpm lint` → PASS.
```bash
git add apps/brain/src/memory/ranking.ts apps/brain/test/ranking.test.ts
git commit -m "feat(brain): hybrid ranking helpers (safe FTS query, reciprocal rank fusion)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Le magasin de souvenirs

**Files:**
- Create: `apps/brain/src/memory/store.ts`
- Test: `apps/brain/test/memory-store.test.ts`

Règles :
- Une personne voit et modifie **le commun et les siens**, jamais ceux d'une autre. Le paramètre `scope` des méthodes est relatif : `"personal"` = la personne qui agit.
- `remember` refuse les mots de passe/codes, détecte les quasi-doublons dans la même portée (similarité ≥ seuil), et ne sert jamais un souvenir oublié.
- `search` fusionne plein texte et similarité, filtre les portées **avant** le classement, ignore les souvenirs dont la similarité est sous un plancher (sauf s'ils sortent aussi du plein texte), et met à jour le compteur de rappel.
- `forget` est un oubli doux ; `purgeForgotten` supprime définitivement les oubliés depuis plus de 30 jours.

- [ ] **Step 1: Écrire les tests**

`apps/brain/test/memory-store.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createTestClock, createTestDb } from "./helpers.ts";

function setup() {
  const db = createTestDb();
  const time = createTestClock();
  const store = new MemoryStore(db, new FakeEmbedder(), time.clock, { duplicateThreshold: 0.95, minSimilarity: 0.3 });
  return { db, time, store };
}

const remember = (store: MemoryStore, personId: string, text: string, scope: "common" | "personal" = "personal") =>
  store.remember({ personId, scope, kind: "preference", text, source: "conversation" });

describe("MemoryStore", () => {
  test("remember then search finds it, and counts the recall", async () => {
    const { store } = setup();
    const created = await remember(store, "kevin", "Kévin adore les lasagnes");
    expect(created.status).toBe("created");
    const found = await store.search("kevin", "lasagnes");
    expect(found.map((m) => m.text)).toEqual(["Kévin adore les lasagnes"]);
    expect(found[0]?.recallCount).toBe(1);
  });

  test("cloisonnement: Élodie never sees, finds, edits or forgets Kévin's personal memories", async () => {
    const { store } = setup();
    const result = await remember(store, "kevin", "Kévin prépare une surprise pour Élodie");
    if (result.status !== "created") throw new Error("not created");
    const id = result.memory.id;
    expect(await store.search("elodie", "surprise")).toEqual([]);
    expect(store.list("elodie", {})).toEqual([]);
    expect(store.get("elodie", id)).toBeUndefined();
    expect(await store.update("elodie", id, { text: "piraté" })).toBeUndefined();
    expect(store.forget("elodie", id)).toBe(false);
    expect(store.get("kevin", id)?.text).toBe("Kévin prépare une surprise pour Élodie");
  });

  test("common memories are shared", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Le chauffe-eau se lance en heures creuses", "common");
    expect((await store.search("elodie", "chauffe-eau")).map((m) => m.scope)).toEqual(["common"]);
  });

  test("near-duplicate in the same scope is not stored twice", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Kévin adore les lasagnes");
    const again = await remember(store, "kevin", "kévin adore les LASAGNES !");
    expect(again.status).toBe("duplicate");
    expect(store.list("kevin", {})).toHaveLength(1);
  });

  test("refuses passwords and codes", async () => {
    const { store } = setup();
    expect((await remember(store, "kevin", "Le mot de passe du wifi est hunter2")).status).toBe("refused");
    expect((await remember(store, "kevin", "Code PIN de la carte : 1234")).status).toBe("refused");
  });

  test("update text re-embeds and moves scope (common ↔ own personal only)", async () => {
    const { store } = setup();
    const result = await remember(store, "kevin", "Élodie aime le thé vert", "common");
    if (result.status !== "created") throw new Error("not created");
    const updated = await store.update("kevin", result.memory.id, { text: "Kévin aime le thé vert", scope: "personal" });
    expect(updated?.scope).toBe("kevin");
    expect((await store.search("kevin", "thé vert")).map((m) => m.text)).toEqual(["Kévin aime le thé vert"]);
    expect(await store.search("elodie", "thé vert")).toEqual([]);
  });

  test("forget is soft, purge removes after 30 days", async () => {
    const { store, time } = setup();
    const result = await remember(store, "kevin", "Rendez-vous chez le dentiste mardi");
    if (result.status !== "created") throw new Error("not created");
    expect(store.forget("kevin", result.memory.id)).toBe(true);
    expect(await store.search("kevin", "dentiste")).toEqual([]);
    expect(store.purgeForgotten()).toBe(0);
    time.advance(31 * 24 * 3_600_000);
    expect(store.purgeForgotten()).toBe(1);
  });

  test("unrelated query returns nothing (similarity floor)", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Kévin adore les lasagnes");
    expect(await store.search("kevin", "météo demain")).toEqual([]);
  });

  test("pinned and rules for the sheet", async () => {
    const { store } = setup();
    await store.remember({ personId: "kevin", scope: "common", kind: "rule", text: "On ne chauffe pas au-delà de 20 °C", source: "manual" });
    await store.remember({ personId: "kevin", scope: "personal", kind: "fact", text: "Kévin est allergique aux noix", source: "manual", pinned: true });
    await remember(store, "elodie", "Élodie déteste le coriandre");
    const sheet = store.sheetMemories("kevin");
    expect(sheet.rules.map((m) => m.text)).toEqual(["On ne chauffe pas au-delà de 20 °C"]);
    expect(sheet.pinnedPersonal.map((m) => m.text)).toEqual(["Kévin est allergique aux noix"]);
    expect(sheet.pinnedCommon).toEqual([]);
  });
});
```
(`createTestClock` = l'aide d'horloge existante dans `test/helpers.ts`, avec `clock` et `advance` ; adapter les noms réels.)

Run: FAIL.

- [ ] **Step 2: Écrire le magasin**

`apps/brain/src/memory/store.ts` :
```ts
import { randomUUID } from "node:crypto";
import type { MemoryKind, MemoryScope } from "@alicia/protocol";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/open.ts";
import { memories } from "../db/schema.ts";
import { cosine, type Embedder, fromBlob, toBlob } from "./embedder.ts";
import { ftsQuery, fuse } from "./ranking.ts";

export type MemoryRow = typeof memories.$inferSelect;
/** A memory without its vector, as the rest of the brain sees it. */
export type Memory = Omit<MemoryRow, "embedding" | "embeddingModel" | "importKey">;

export interface RememberInput {
  personId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  text: string;
  source: MemoryRow["source"];
  pinned?: boolean;
  conversationId?: string;
  /** Import only: keeps the original bookkeeping. */
  importKey?: string;
  createdAt?: number;
  recallCount?: number;
  lastRecalledAt?: number | null;
}

export type RememberResult =
  | { status: "created"; memory: Memory }
  | { status: "duplicate"; memory: Memory }
  | { status: "refused"; reason: "secret" };

export interface MemoryPatchInput {
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  pinned?: boolean;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  kind?: MemoryKind;
}

export interface MemoryStoreOptions {
  /** Same-scope similarity at or above which a new memory is a duplicate. */
  duplicateThreshold?: number;
  /** Below this similarity a vector-only match is noise (e5 has a high floor). */
  minSimilarity?: number;
}

export interface SheetMemories {
  rules: Memory[];
  pinnedCommon: Memory[];
  pinnedPersonal: Memory[];
}

const COMMON = "common";
const CANDIDATES = 50;
const SEARCH_LIMIT = 8;
const FORGET_RETENTION_MS = 30 * 24 * 3_600_000;
const SECRET = /\b(mots? de passe|password|mdp|code (pin|secret|d'acc[eè]s)|pin\b|cvv|cryptogramme)/i;

function strip(row: MemoryRow): Memory {
  const { embedding: _embedding, embeddingModel: _model, importKey: _key, ...memory } = row;
  return memory;
}

export class MemoryStore {
  readonly #db: Db;
  readonly #embedder: Embedder;
  readonly #clock: Clock;
  readonly #duplicateThreshold: number;
  readonly #minSimilarity: number;

  constructor(db: Db, embedder: Embedder, clock: Clock, options: MemoryStoreOptions = {}) {
    this.#db = db;
    this.#embedder = embedder;
    this.#clock = clock;
    this.#duplicateThreshold = options.duplicateThreshold ?? 0.92;
    this.#minSimilarity = options.minSimilarity ?? 0.8;
  }

  /** Scopes a person may read and write: the household's and their own. */
  #scopes(personId: string): string[] {
    return [COMMON, personId];
  }

  #storedScope(personId: string, scope: MemoryScope): string {
    return scope === "common" ? COMMON : personId;
  }

  #visible(personId: string, id: string): MemoryRow | undefined {
    return this.#db
      .select()
      .from(memories)
      .where(and(eq(memories.id, id), inArray(memories.scope, this.#scopes(personId)), isNull(memories.forgottenAt)))
      .get();
  }

  get(personId: string, id: string): Memory | undefined {
    const row = this.#visible(personId, id);
    return row === undefined ? undefined : strip(row);
  }

  list(personId: string, filter: MemoryFilter): Memory[] {
    const scopes = filter.scope === undefined ? this.#scopes(personId) : [this.#storedScope(personId, filter.scope)];
    return this.#db
      .select()
      .from(memories)
      .where(
        and(
          inArray(memories.scope, scopes),
          isNull(memories.forgottenAt),
          filter.kind === undefined ? undefined : eq(memories.kind, filter.kind),
        ),
      )
      .orderBy(desc(memories.updatedAt), sql`rowid desc`)
      .all()
      .map(strip);
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const text = input.text.trim();
    if (SECRET.test(text)) return { status: "refused", reason: "secret" };
    const scope = this.#storedScope(input.personId, input.scope);
    const [vector] = await this.#embedder.embed([text], "passage");
    if (vector === undefined) throw new Error("Embedder returned no vector");

    const duplicate = this.#closest(vector, [scope]);
    if (duplicate !== undefined && duplicate.similarity >= this.#duplicateThreshold) {
      return { status: "duplicate", memory: strip(duplicate.row) };
    }

    const now = this.#clock();
    const row: MemoryRow = {
      id: randomUUID(),
      scope,
      kind: input.kind,
      text,
      pinned: input.pinned ?? false,
      source: input.source,
      conversationId: input.conversationId ?? null,
      importKey: input.importKey ?? null,
      embedding: toBlob(vector),
      embeddingModel: this.#embedder.model,
      recallCount: input.recallCount ?? 0,
      lastRecalledAt: input.lastRecalledAt ?? null,
      forgottenAt: null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    this.#db.insert(memories).values(row).run();
    return { status: "created", memory: strip(row) };
  }

  hasImportKey(importKey: string): boolean {
    return this.#db.select({ id: memories.id }).from(memories).where(eq(memories.importKey, importKey)).get() !== undefined;
  }

  async search(personId: string, query: string, limit = SEARCH_LIMIT): Promise<Memory[]> {
    const scopes = this.#scopes(personId);
    const textRanked = this.#fullText(query, scopes);
    const [vector] = await this.#embedder.embed([query], "query");
    if (vector === undefined) throw new Error("Embedder returned no vector");
    const vectorRanked = this.#active(scopes)
      .map((row) => ({ id: row.id, similarity: cosine(vector, fromBlob(row.embedding)) }))
      .filter((hit) => hit.similarity >= this.#minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CANDIDATES)
      .map((hit) => hit.id);

    const ids = fuse([textRanked, vectorRanked]).slice(0, limit);
    if (ids.length === 0) return [];
    const now = this.#clock();
    this.#db
      .update(memories)
      .set({ recallCount: sql`${memories.recallCount} + 1`, lastRecalledAt: now })
      .where(inArray(memories.id, ids))
      .run();
    const rows = new Map(
      this.#db.select().from(memories).where(inArray(memories.id, ids)).all().map((row) => [row.id, row]),
    );
    return ids.flatMap((id) => {
      const row = rows.get(id);
      return row === undefined ? [] : [strip(row)];
    });
  }

  async update(personId: string, id: string, patch: MemoryPatchInput): Promise<Memory | undefined> {
    const row = this.#visible(personId, id);
    if (row === undefined) return undefined;
    const text = patch.text?.trim();
    if (text !== undefined && SECRET.test(text)) return undefined;
    let embedding = row.embedding;
    if (text !== undefined && text !== row.text) {
      const [vector] = await this.#embedder.embed([text], "passage");
      if (vector === undefined) throw new Error("Embedder returned no vector");
      embedding = toBlob(vector);
    }
    const next: Partial<MemoryRow> = {
      ...(text !== undefined ? { text, embedding, embeddingModel: this.#embedder.model } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.scope !== undefined ? { scope: this.#storedScope(personId, patch.scope) } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      updatedAt: this.#clock(),
    };
    this.#db.update(memories).set(next).where(eq(memories.id, id)).run();
    return this.get(personId, id) ?? undefined;
  }

  forget(personId: string, id: string): boolean {
    if (this.#visible(personId, id) === undefined) return false;
    this.#db.update(memories).set({ forgottenAt: this.#clock() }).where(eq(memories.id, id)).run();
    return true;
  }

  /** Deletes memories forgotten more than 30 days ago; returns how many. */
  purgeForgotten(): number {
    return this.#db
      .delete(memories)
      .where(and(isNotNull(memories.forgottenAt), lt(memories.forgottenAt, this.#clock() - FORGET_RETENTION_MS)))
      .run().changes;
  }

  /** What the permanent sheet shows for this person (house rules, pinned memories). */
  sheetMemories(personId: string): SheetMemories {
    const pinnedOrRule = this.#db
      .select()
      .from(memories)
      .where(and(inArray(memories.scope, this.#scopes(personId)), isNull(memories.forgottenAt)))
      .orderBy(desc(memories.recallCount), asc(memories.createdAt))
      .all()
      .filter((row) => row.pinned || (row.kind === "rule" && row.scope === COMMON))
      .map(strip);
    return {
      rules: pinnedOrRule.filter((m) => m.kind === "rule" && m.scope === COMMON),
      pinnedCommon: pinnedOrRule.filter((m) => m.scope === COMMON && m.kind !== "rule"),
      pinnedPersonal: pinnedOrRule.filter((m) => m.scope === personId),
    };
  }

  #active(scopes: string[]): MemoryRow[] {
    return this.#db
      .select()
      .from(memories)
      .where(and(inArray(memories.scope, scopes), isNull(memories.forgottenAt)))
      .all();
  }

  #closest(vector: Float32Array, scopes: string[]): { row: MemoryRow; similarity: number } | undefined {
    let best: { row: MemoryRow; similarity: number } | undefined;
    for (const row of this.#active(scopes)) {
      const similarity = cosine(vector, fromBlob(row.embedding));
      if (best === undefined || similarity > best.similarity) best = { row, similarity };
    }
    return best;
  }

  #fullText(query: string, scopes: string[]): string[] {
    const match = ftsQuery(query);
    if (match === null) return [];
    const placeholders = scopes.map(() => "?").join(", ");
    return this.#db.$client
      .prepare(
        `SELECT m.id AS id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.scope IN (${placeholders}) AND m.forgotten_at IS NULL
         ORDER BY bm25(memories_fts) LIMIT ${CANDIDATES}`,
      )
      .all(match, ...scopes)
      .flatMap((row) => (typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" ? [row.id] : []));
  }
}
```
Notes pour l'implémenteur :
- Vérifier le seuil de doublon du test avec le `FakeEmbedder` (même mots → similarité 1) ; `minSimilarity: 0.3` dans le test donne un plancher raisonnable pour le faux modèle.
- Les valeurs par défaut (`0.92`, `0.80`) visent e5 ; elles seront revues lors de la vérification réelle (tâche 10).
- Si ESLint refuse les variables `_embedding`… de la déstructuration (`no-unused-vars`), construire l'objet `Memory` champ par champ plutôt que de désactiver la règle.

- [ ] **Step 3: Tests puis commit**

Run: `pnpm --filter @alicia/brain test memory-store && pnpm typecheck && pnpm lint` → PASS.
```bash
git add apps/brain/src/memory/store.ts apps/brain/test/memory-store.test.ts
git commit -m "feat(brain): memory store (scoped, hybrid search, dedupe, soft forget, sheet)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: La fiche permanente et la consigne

**Files:**
- Create: `apps/brain/src/memory/sheet.ts`
- Modify: `apps/brain/src/agent/system-prompt.ts`
- Test: `apps/brain/test/sheet.test.ts`, `apps/brain/test/agent.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/brain/test/sheet.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { buildSheet } from "../src/memory/sheet.ts";
import type { Memory } from "../src/memory/store.ts";

const memory = (text: string, overrides: Partial<Memory> = {}): Memory => ({
  id: text, scope: "common", kind: "fact", text, pinned: true, source: "manual", conversationId: null,
  recallCount: 0, lastRecalledAt: null, forgottenAt: null, createdAt: 0, updatedAt: 0, ...overrides,
});

describe("buildSheet", () => {
  test("empty memory → empty sheet", () => {
    expect(buildSheet({ rules: [], pinnedCommon: [], pinnedPersonal: [] }, "Kévin")).toBe("");
  });

  test("sections in order: rules, personal, household", () => {
    const sheet = buildSheet(
      {
        rules: [memory("Pas plus de 20 °C", { kind: "rule" })],
        pinnedCommon: [memory("Le chat s'appelle Moka")],
        pinnedPersonal: [memory("Allergique aux noix", { scope: "kevin" })],
      },
      "Kévin",
    );
    expect(sheet).toBe(
      "Ce que tu sais déjà (mémoire) :\n" +
        "Règles de la maison :\n- Pas plus de 20 °C\n" +
        "À propos de Kévin :\n- Allergique aux noix\n" +
        "À propos de la famille :\n- Le chat s'appelle Moka",
    );
  });

  test("respects the budget, rules first", () => {
    const long = "x".repeat(60);
    const sheet = buildSheet(
      { rules: [memory("Règle importante", { kind: "rule" })], pinnedCommon: [], pinnedPersonal: [memory(long), memory(`${long}2`)] },
      "Kévin",
      150,
    );
    expect(sheet).toContain("Règle importante");
    expect(sheet.length).toBeLessThanOrEqual(150);
    expect(sheet).not.toContain(`${long}2`);
  });
});
```

Dans `apps/brain/test/agent.test.ts`, ajouter :
```ts
test("system prompt explains memory and appends the sheet", () => {
  const prompt = buildSystemPrompt(KEVIN, "Ce que tu sais déjà (mémoire) :\n- X");
  expect(prompt).toContain("memory_search");
  expect(prompt).toContain("Tu parles avec Kévin.");
  expect(prompt.endsWith("Ce que tu sais déjà (mémoire) :\n- X")).toBe(true);
  expect(buildSystemPrompt(KEVIN, "")).not.toContain("Ce que tu sais déjà");
});
```
et adapter les appels existants `buildSystemPrompt(KEVIN)` en `buildSystemPrompt(KEVIN, "")`.

Run: FAIL.

- [ ] **Step 2: Écrire la fiche**

`apps/brain/src/memory/sheet.ts` :
```ts
import type { Memory, SheetMemories } from "./store.ts";

/** ~2 000 tokens of French text. */
export const SHEET_BUDGET_CHARS = 7000;

/** The permanent sheet injected in every system prompt. Most useful memories first; trimmed to budget. */
export function buildSheet(memories: SheetMemories, personName: string, budget = SHEET_BUDGET_CHARS): string {
  const sections: [string, readonly Memory[]][] = [
    ["Règles de la maison :", memories.rules],
    [`À propos de ${personName} :`, memories.pinnedPersonal],
    ["À propos de la famille :", memories.pinnedCommon],
  ];
  const header = "Ce que tu sais déjà (mémoire) :";
  let sheet = header;
  for (const [title, items] of sections) {
    let section = "";
    for (const item of items) {
      const line = `\n- ${item.text}`;
      const candidate = `\n${title}${section}${line}`;
      if (sheet.length + candidate.length > budget) break;
      section += line;
    }
    if (section !== "") sheet += `\n${title}${section}`;
  }
  return sheet === header ? "" : sheet;
}
```

- [ ] **Step 3: Consigne**

Dans `apps/brain/src/agent/system-prompt.ts` :
```ts
/** How Alicia uses her memory (tools: memory_search, memory_remember, memory_update, memory_forget). */
export const MEMORY_GUIDE = `Mémoire :
- Tu as une mémoire durable : « common » pour toute la famille, « personal » pour la personne qui te parle.
- Avant de dire que tu ne sais pas quelque chose sur la famille, la maison ou les habitudes, cherche dans ta mémoire (memory_search).
- Retiens d'office (memory_remember) ce qui restera vrai : préférences, habitudes, faits, événements à venir, règles de la maison. Pas les banalités du moment.
- En cas de doute entre « common » et « personal », choisis « personal ».
- Ne retiens jamais de mots de passe, de codes ni de données bancaires.
- Si on te corrige, mets le souvenir à jour (memory_update) au lieu d'en créer un autre ; si on te demande d'oublier, utilise memory_forget.`;

/** System prompt: stable for a given person and sheet (prompt caching). */
export function buildSystemPrompt(person: Person, sheet: string): string {
  const base = `${PERSONA}\n\n${MEMORY_GUIDE}\n\nTu parles avec ${person.name}.`;
  return sheet === "" ? base : `${base}\n\n${sheet}`;
}
```
Mettre à jour les appels existants (chat-service, CLI `check-engine`) avec `""` en attendant la tâche 7.

- [ ] **Step 4: Tests puis commit**

Run: `pnpm --filter @alicia/brain test && pnpm typecheck && pnpm lint` → PASS.
```bash
git add apps/brain/src/memory/sheet.ts apps/brain/src/agent/system-prompt.ts apps/brain/test/sheet.test.ts apps/brain/test/agent.test.ts apps/brain/src/conversations/chat-service.ts apps/brain/src/cli.ts
git commit -m "feat(brain): permanent memory sheet and memory guide in the system prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Les outils dans le moteur

**Files:**
- Create: `apps/brain/src/engine/tools.ts`
- Modify: `apps/brain/src/engine/engine.ts`, `apps/brain/src/engine/sdk-engine.ts`, `apps/brain/src/engine/fake-engine.ts`
- Test: `apps/brain/test/sdk-engine.test.ts`, `apps/brain/test/fake-engine.test.ts`

- [ ] **Step 1: Tests**

Dans `apps/brain/test/fake-engine.test.ts`, ajouter :
```ts
test("an async scenario can call a tool of the request", async () => {
  const echo = defineTool({
    name: "echo", description: "Répète", input: { word: z.string() },
    run: ({ word }) => Promise.resolve({ text: `écho ${word}` }),
  });
  const engine = new FakeEngine(async (request) => {
    const result = await callTool(request, "echo", { word: "bonjour" });
    return [{ type: "text", text: result.text }];
  });
  const events = await collect(engine.run({ ...REQUEST, tools: [echo] }, new AbortController().signal));
  expect(events).toEqual([{ type: "text", text: "écho bonjour" }]);
});
```
(`collect` et `REQUEST` sont les aides déjà présentes dans ce fichier ; ajouter `tools: []` à `REQUEST`. Importer `z` de `zod`, `defineTool` de `../src/engine/tools.ts`, `callTool` de `../src/engine/fake-engine.ts`.)

Dans `apps/brain/test/sdk-engine.test.ts`, ajouter :
```ts
test("tool names are reported without the MCP prefix", () => {
  expect(
    translate({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__alicia__memory_search", input: {} }] } }),
  ).toEqual([{ type: "tool_call", callId: "t1", tool: "memory_search" }]);
});

test("toolNames lists the allowed MCP names", () => {
  const tool = defineTool({ name: "memory_search", description: "d", input: {}, run: () => Promise.resolve({ text: "" }) });
  expect(allowedToolNames([tool])).toEqual(["mcp__alicia__memory_search"]);
});
```

Run: FAIL.

- [ ] **Step 2: L'abstraction d'outil**

`apps/brain/src/engine/tools.ts` :
```ts
import type { z } from "zod";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/**
 * A tool Alicia can call, independent of the SDK. `run` is declared as a method on purpose:
 * tools with different input shapes can then live in one `ToolDefinition[]`.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: Shape;
  run(args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}
```

`apps/brain/src/engine/engine.ts` : ajouter à `EngineRequest` :
```ts
  /** Tools available for this turn (bound to the person speaking). */
  tools: readonly ToolDefinition[];
```

- [ ] **Step 3: Le moteur SDK**

Dans `apps/brain/src/engine/sdk-engine.ts` :
```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDefinition } from "./tools.ts";

const MCP_SERVER = "alicia";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

export function allowedToolNames(tools: readonly ToolDefinition[]): string[] {
  return tools.map((t) => `${MCP_PREFIX}${t.name}`);
}

function toolLabel(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}
```
- Dans `translateMessage`, cas `tool_use` : `tool: toolLabel(block.name)`.
- Dans `SdkEngine.run`, quand `request.tools` n'est pas vide :
```ts
const server = createSdkMcpServer({
  name: MCP_SERVER,
  version: VERSION,
  tools: request.tools.map((definition) =>
    tool(definition.name, definition.description, definition.input, async (args) => {
      const result = await definition.run(args);
      return { content: [{ type: "text" as const, text: result.text }], ...(result.isError === true ? { isError: true } : {}) };
    }),
  ),
});
```
puis dans les options : `mcpServers: { [MCP_SERVER]: server }`, `allowedTools: allowedToolNames(request.tools)` ; garder `tools: []` (outils intégrés de Claude Code désactivés), `strictMcpConfig: true`, et le `canUseTool` qui refuse tout le reste.
Vérifier dans `sdk.d.ts` la signature réelle de `tool()` (forme du schéma attendue : objet de forme Zod v4 ou v3 — `zod` 4 expose `zod/v3` si nécessaire) et de `createSdkMcpServer`, et aligner sans `any` ni assertion.

- [ ] **Step 4: Le faux moteur**

Dans `apps/brain/src/engine/fake-engine.ts` :
```ts
export type Scenario = (request: EngineRequest) => readonly EngineEvent[] | Promise<readonly EngineEvent[]>;

/** Test helper: lets a scenario call one of the request's tools like the model would. */
export async function callTool(request: EngineRequest, name: string, args: unknown): Promise<ToolResult> {
  const definition = request.tools.find((t) => t.name === name);
  if (definition === undefined) throw new Error(`No tool named ${name}`);
  const parsed = z.object(definition.input).parse(args);
  return definition.run(parsed);
}
```
et dans `run`, garder l'appel **synchrone** du scénario (un scénario qui lève fait lever `run`), puis `const events = await result;` dans le générateur.

- [ ] **Step 5: Tests, mise à jour des appels, commit**

Ajouter `tools: []` partout où une `EngineRequest` est construite (chat-service, CLI `check-engine`, tests). Run: `pnpm test && pnpm typecheck && pnpm lint` → PASS.
```bash
git add apps/brain/src/engine apps/brain/test/fake-engine.test.ts apps/brain/test/sdk-engine.test.ts apps/brain/src/conversations/chat-service.ts apps/brain/src/cli.ts apps/brain/test
git commit -m "feat(brain): tool definitions served to the SDK as an in-process MCP server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Les outils mémoire et leur branchement

**Files:**
- Create: `apps/brain/src/memory/tools.ts`
- Modify: `apps/brain/src/conversations/chat-service.ts`, `apps/brain/src/server/server.ts` (dépendances), `apps/brain/test/helpers.ts`
- Test: `apps/brain/test/memory-tools.test.ts`, `apps/brain/test/chat-service.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/brain/test/memory-tools.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { callTool } from "../src/engine/fake-engine.ts";
import type { EngineRequest } from "../src/engine/engine.ts";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { createTestClock, createTestDb, ELODIE, KEVIN } from "./helpers.ts";

function setup() {
  const store = new MemoryStore(createTestDb(), new FakeEmbedder(), createTestClock().clock, { duplicateThreshold: 0.95, minSimilarity: 0.3 });
  const requestFor = (person: typeof KEVIN): EngineRequest => ({
    prompt: "", sessionId: undefined, model: "sonnet", systemPrompt: "", tools: memoryTools(store, person, null),
  });
  return { store, kevin: requestFor(KEVIN), elodie: requestFor(ELODIE) };
}

describe("memory tools", () => {
  test("remember then search through the tools", async () => {
    const { kevin } = setup();
    const saved = await callTool(kevin, "memory_remember", { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" });
    expect(saved.text).toMatch(/^Retenu/);
    const found = await callTool(kevin, "memory_search", { query: "lasagnes" });
    expect(found.text).toContain("Kévin adore les lasagnes");
    expect(found.text).toContain("personnel");
  });

  test("duplicate and refused secrets are explained", async () => {
    const { kevin } = setup();
    await callTool(kevin, "memory_remember", { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" });
    expect((await callTool(kevin, "memory_remember", { text: "kévin adore les lasagnes", kind: "preference", scope: "personal" })).text)
      .toMatch(/^Déjà en mémoire/);
    const refused = await callTool(kevin, "memory_remember", { text: "Mot de passe wifi : hunter2", kind: "fact", scope: "common" });
    expect(refused).toEqual({ text: "Refusé : je ne retiens ni mots de passe ni codes.", isError: true });
  });

  test("cloisonnement through the tools: Élodie can't touch Kévin's memory even with its id", async () => {
    const { store, kevin, elodie } = setup();
    await callTool(kevin, "memory_remember", { text: "Surprise pour l'anniversaire d'Élodie", kind: "event", scope: "personal" });
    const id = store.list("kevin", {})[0]?.id ?? "";
    expect((await callTool(elodie, "memory_search", { query: "anniversaire surprise" })).text).toBe("Aucun souvenir trouvé.");
    expect((await callTool(elodie, "memory_update", { id, text: "rien" })).text).toBe("Souvenir introuvable.");
    expect((await callTool(elodie, "memory_forget", { id })).text).toBe("Souvenir introuvable.");
    expect(store.get("kevin", id)?.text).toBe("Surprise pour l'anniversaire d'Élodie");
  });

  test("update and forget", async () => {
    const { store, kevin } = setup();
    await callTool(kevin, "memory_remember", { text: "Kévin boit du café", kind: "habit", scope: "personal" });
    const id = store.list("kevin", {})[0]?.id ?? "";
    expect((await callTool(kevin, "memory_update", { id, text: "Kévin boit du thé", pinned: true })).text).toMatch(/^Mis à jour/);
    expect(store.get("kevin", id)).toMatchObject({ text: "Kévin boit du thé", pinned: true });
    expect((await callTool(kevin, "memory_forget", { id })).text).toBe("Oublié (récupérable 30 jours).");
    expect(store.get("kevin", id)).toBeUndefined();
  });
});
```

Dans `apps/brain/test/chat-service.test.ts`, ajouter `memory` aux dépendances de test (un `MemoryStore` avec `FakeEmbedder`) et :
```ts
test("the engine receives the memory tools and the sheet", async () => {
  const { deps, engine } = createContext(REPLY);
  await deps.memory.remember({ personId: "kevin", scope: "common", kind: "rule", text: "Pas plus de 20 °C", source: "manual" });
  await send(deps, KEVIN, { text: "Salut" });
  expect(engine.requests[0]?.tools.map((t) => t.name)).toEqual(["memory_search", "memory_remember", "memory_update", "memory_forget"]);
  expect(engine.requests[0]?.systemPrompt).toContain("Pas plus de 20 °C");
});

test("a memory remembered during a turn is linked to the conversation", async () => {
  const { deps } = createContext(async (request) => {
    await callTool(request, "memory_remember", { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" });
    return [{ type: "text", text: "Noté !" }, { type: "done", inputTokens: 1, outputTokens: 1 }];
  });
  const events = await send(deps, KEVIN, { text: "Retiens que j'adore les lasagnes" });
  const conversationId = events[0]?.type === "conversation" ? events[0].conversationId : "";
  expect(deps.memory.list("kevin", {})[0]?.conversationId).toBe(conversationId);
});
```
(`createContext`, `send`, `REPLY` : noms réels des aides du fichier ; adapter.)

Run: FAIL.

- [ ] **Step 2: Les outils**

`apps/brain/src/memory/tools.ts` :
```ts
import { MEMORY_KINDS, MemoryScope, type Person } from "@alicia/protocol";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "../engine/tools.ts";
import type { Memory, MemoryStore } from "./store.ts";

const KIND_LABELS: Readonly<Record<Memory["kind"], string>> = {
  rule: "règle",
  preference: "préférence",
  habit: "habitude",
  fact: "fait",
  event: "événement",
};

function describe(memory: Memory): string {
  const scope = memory.scope === "common" ? "commun" : "personnel";
  const pinned = memory.pinned ? " · épinglé" : "";
  return `[${memory.id}] (${scope} · ${KIND_LABELS[memory.kind]}${pinned}) ${memory.text}`;
}

const NOT_FOUND = { text: "Souvenir introuvable.", isError: true } as const;

/** Memory tools bound to the person speaking: they can only ever reach "common" and that person. */
export function memoryTools(store: MemoryStore, person: Person, conversationId: string | null): ToolDefinition[] {
  return [
    defineTool({
      name: "memory_search",
      description: "Cherche dans ta mémoire (commune et personnelle de la personne qui te parle). Donne des mots-clés ou une question.",
      input: { query: z.string().min(1).max(300) },
      async run({ query }) {
        const found = await store.search(person.id, query);
        return { text: found.length === 0 ? "Aucun souvenir trouvé." : found.map(describe).join("\n") };
      },
    }),
    defineTool({
      name: "memory_remember",
      description:
        "Retiens un souvenir durable. scope : « common » (toute la famille) ou « personal » (la personne qui te parle). kind : rule, preference, habit, fact, event.",
      input: {
        text: z.string().min(1).max(1000),
        kind: z.enum(MEMORY_KINDS),
        scope: MemoryScope,
        pinned: z.boolean().optional(),
      },
      async run({ text, kind, scope, pinned }) {
        const result = await store.remember({
          personId: person.id, scope, kind, text, source: "conversation",
          ...(pinned !== undefined ? { pinned } : {}),
          ...(conversationId !== null ? { conversationId } : {}),
        });
        switch (result.status) {
          case "created":
            return { text: `Retenu : ${describe(result.memory)}` };
          case "duplicate":
            return { text: `Déjà en mémoire : ${describe(result.memory)}` };
          case "refused":
            return { text: "Refusé : je ne retiens ni mots de passe ni codes.", isError: true };
        }
      },
    }),
    defineTool({
      name: "memory_update",
      description: "Corrige un souvenir (texte, type, portée, épinglé) à partir de son identifiant entre crochets.",
      input: {
        id: z.string().min(1),
        text: z.string().min(1).max(1000).optional(),
        kind: z.enum(MEMORY_KINDS).optional(),
        scope: MemoryScope.optional(),
        pinned: z.boolean().optional(),
      },
      async run({ id, ...patch }) {
        const updated = await store.update(person.id, id, patch);
        return updated === undefined ? NOT_FOUND : { text: `Mis à jour : ${describe(updated)}` };
      },
    }),
    defineTool({
      name: "memory_forget",
      description: "Oublie un souvenir à partir de son identifiant entre crochets (récupérable pendant 30 jours).",
      input: { id: z.string().min(1) },
      run({ id }) {
        return Promise.resolve(store.forget(person.id, id) ? { text: "Oublié (récupérable 30 jours)." } : NOT_FOUND);
      },
    }),
  ];
}
```
Note : avec `exactOptionalPropertyTypes`, la déstructuration `{ id, ...patch }` peut donner des propriétés `undefined` explicites refusées par `MemoryPatchInput` : construire `patch` champ par champ avec des spreads conditionnels si `tsc` le signale. Si `MemoryScope` (schéma du protocole) n'est pas accepté comme valeur de forme par `tool()`, utiliser `z.enum(["common", "personal"])`.

- [ ] **Step 3: Branchement dans le chat**

Dans `apps/brain/src/conversations/chat-service.ts` :
- `ChatDependencies` gagne `memory: MemoryStore`.
- Après la création/récupération de la conversation :
```ts
const sheet = buildSheet(deps.memory.sheetMemories(person.id), person.name);
const systemPrompt = buildSystemPrompt(person, sheet);
const tools = memoryTools(deps.memory, person, conversationId);
```
- La requête au moteur inclut `tools`. Renommer la variable locale des appels d'outils journalisés (`loggedTools`) pour éviter le conflit de nom.

Mettre à jour `createServer` / `DependenciesServer` si `ChatDependencies` y est construit, et les aides de test (`test/helpers.ts` : fabrique d'un `MemoryStore` de test avec `FakeEmbedder`, réutilisée par les tests de chat, de serveur HTTP et WebSocket).

- [ ] **Step 4: Tests puis commit**

Run: `pnpm test && pnpm typecheck && pnpm lint` → PASS (y compris l'e2e de l'app : `pnpm --filter @alicia/desktop test:e2e` — adapter `apps/desktop/e2e/app.e2e.ts` si `buildApplication` prend désormais un embedder, cf. tâche 10 ; si la tâche 10 n'est pas faite, l'e2e reste valide tant que `buildApplication` garde un défaut).
```bash
git add apps/brain/src/memory/tools.ts apps/brain/src/conversations/chat-service.ts apps/brain/src/server apps/brain/test
git commit -m "feat(brain): memory tools bound to the person, sheet and tools on every turn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: API HTTP des souvenirs

**Files:**
- Create: `apps/brain/src/server/memory-routes.ts`
- Modify: `apps/brain/src/server/server.ts`
- Test: `apps/brain/test/server-memories.test.ts`

Routes (Bearer obligatoire, portée relative à l'appelant) :
- `GET /memories?scope=common|personal&kind=…&q=…` → `MemorySummary[]` (recherche si `q`, sinon liste)
- `POST /memories` (`MemoryCreate`) → 201 `MemorySummary` ; 409 `{ error: "duplicate" }` ; 422 `{ error: "refused" }`
- `PATCH /memories/:id` (`MemoryPatch`) → `MemorySummary` ; 404 `{ error: "not_found" }`
- `DELETE /memories/:id` → 204 ; 404

- [ ] **Step 1: Écrire les tests**

`apps/brain/test/server-memories.test.ts` (même structure que `server-http.test.ts` : `createServer` avec dépendances de test, appairage pour obtenir un jeton) :
```ts
describe("memories HTTP API", () => {
  test("401 without token", async () => {
    const { app } = await createContext();
    expect((await app.inject({ method: "GET", url: "/memories" })).statusCode).toBe(401);
  });

  test("create, list, search, patch, delete — scoped to the caller", async () => {
    const ctx = await createContext();
    const kevin = await pair(ctx, "kevin");
    const elodie = await pair(ctx, "elodie");
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    const created = await ctx.app.inject({
      method: "POST", url: "/memories", headers: auth(kevin),
      payload: { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" },
    });
    expect(created.statusCode).toBe(201);
    const memory = created.json<{ id: string; scope: string }>();
    expect(memory.scope).toBe("personal");

    expect((await ctx.app.inject({ method: "GET", url: "/memories", headers: auth(kevin) })).json<unknown[]>()).toHaveLength(1);
    expect((await ctx.app.inject({ method: "GET", url: "/memories", headers: auth(elodie) })).json<unknown[]>()).toHaveLength(0);
    expect((await ctx.app.inject({ method: "GET", url: "/memories?q=lasagnes", headers: auth(kevin) })).json<unknown[]>()).toHaveLength(1);

    expect((await ctx.app.inject({ method: "PATCH", url: `/memories/${memory.id}`, headers: auth(elodie), payload: { pinned: true } })).statusCode).toBe(404);
    const patched = await ctx.app.inject({ method: "PATCH", url: `/memories/${memory.id}`, headers: auth(kevin), payload: { pinned: true } });
    expect(patched.json<{ pinned: boolean }>().pinned).toBe(true);

    expect((await ctx.app.inject({ method: "DELETE", url: `/memories/${memory.id}`, headers: auth(elodie) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: `/memories/${memory.id}`, headers: auth(kevin) })).statusCode).toBe(204);
  });

  test("duplicate → 409, secret → 422, invalid body → 400", async () => {
    const ctx = await createContext();
    const headers = { authorization: `Bearer ${await pair(ctx, "kevin")}` };
    const body = { text: "Kévin adore les lasagnes", kind: "preference", scope: "personal" };
    await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: body });
    expect((await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: body })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: { ...body, text: "mot de passe : x" } })).statusCode).toBe(422);
    expect((await ctx.app.inject({ method: "POST", url: "/memories", headers, payload: { text: "x" } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Écrire les routes**

`apps/brain/src/server/memory-routes.ts` : une fonction `registerMemoryRoutes(app, { memory, authenticate })` qui :
- authentifie comme les autres routes (réutiliser la fonction `personOf(request)` de `server.ts` — l'exporter ou la passer en paramètre) ;
- valide la requête avec `MemoryCreate` / `MemoryPatch` / un schéma de query `z.object({ scope: MemoryScope.optional(), kind: MemoryKind.optional(), q: z.string().trim().min(1).max(300).optional() })` ;
- convertit un `Memory` en `MemorySummary` : `scope: memory.scope === "common" ? "common" : "personal"`, dates en ISO ;
- renvoie les codes ci-dessus avec des corps `{ error: "<code>" }`.

L'enregistrer dans `createServer`, avec `memory` ajouté à `ServerDependencies`.

- [ ] **Step 3: Tests puis commit**

Run: `pnpm test && pnpm typecheck && pnpm lint` → PASS.
```bash
git add apps/brain/src/server/memory-routes.ts apps/brain/src/server/server.ts apps/brain/test/server-memories.test.ts
git commit -m "feat(brain): /memories HTTP API scoped to the caller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Import de l'ancienne Alice

**Files:**
- Create: `apps/brain/src/memory/import-alice.ts`
- Modify: `apps/brain/src/cli.ts`
- Test: `apps/brain/test/import-alice.test.ts`

Source (vérifiée sur une copie locale) : `data/memory/chroma.sqlite3` de l'ancienne Alice. Tables `embeddings(id, embedding_id, …)` et `embedding_metadata(id, key, string_value, int_value, float_value, bool_value)`. Clés : `chroma:document` (texte), `created` (secondes Unix), `hits`, `last_recalled` (secondes Unix, facultatif), `pinned` (booléen), `source` (`user` | `inferred`). Règles : `data/regles.json` = `{"regles":[{"id":"<5 hex>","texte":"…","cree_le":"ISO","par":"pwa"|"chat"}]}` (présent sur le Pi uniquement).

Correspondances : tout arrive en portée **common** (l'ancienne Alice n'avait qu'une mémoire familiale) ; souvenirs → `kind: "fact"`, `pinned` conservé, `source: "import"`, `createdAt`/`recallCount`/`lastRecalledAt` conservés (×1000) ; règles → `kind: "rule"`, `pinned: true`. Clé d'idempotence : `alice:chroma:<embedding_id>` et `alice:rule:<id>`. Vecteurs recalculés avec le nouveau modèle.

- [ ] **Step 1: Écrire les tests**

`apps/brain/test/import-alice.test.ts` :
```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { FakeEmbedder } from "../src/memory/fake-embedder.ts";
import { importAlice, readAliceMemories, readAliceRules } from "../src/memory/import-alice.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createTestClock, createTestDb } from "./helpers.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

/** Minimal copy of the Chroma tables the importer reads. */
function fakeChroma(path: string): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE embeddings (id INTEGER PRIMARY KEY, segment_id TEXT, embedding_id TEXT, seq_id BLOB, created_at TEXT);
           CREATE TABLE embedding_metadata (id INTEGER, key TEXT, string_value TEXT, int_value INTEGER, float_value REAL, bool_value INTEGER);`);
  const meta = db.prepare("INSERT INTO embedding_metadata (id, key, string_value, int_value, bool_value) VALUES (?, ?, ?, ?, ?)");
  db.prepare("INSERT INTO embeddings (id, segment_id, embedding_id) VALUES (1, 's', 'e-1'), (2, 's', 'e-2')").run();
  meta.run(1, "chroma:document", "Le chat s'appelle Moka", null, null);
  meta.run(1, "created", null, 1_783_852_500, null);
  meta.run(1, "hits", null, 6, null);
  meta.run(1, "last_recalled", null, 1_784_073_972, null);
  meta.run(1, "pinned", null, null, 1);
  meta.run(1, "source", "user", null, null);
  meta.run(2, "chroma:document", "Kévin aime le café serré", null, null);
  meta.run(2, "created", null, 1_783_900_000, null);
  meta.run(2, "hits", null, 0, null);
  meta.run(2, "pinned", null, null, 0);
  meta.run(2, "source", "inferred", null, null);
  db.close();
}

describe("import from the old Alice", () => {
  test("reads memories and rules", () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-import-"));
    const chroma = join(dir, "chroma.sqlite3");
    fakeChroma(chroma);
    expect(readAliceMemories(chroma)).toEqual([
      { key: "alice:chroma:e-1", text: "Le chat s'appelle Moka", pinned: true, createdAt: 1_783_852_500_000, recallCount: 6, lastRecalledAt: 1_784_073_972_000 },
      { key: "alice:chroma:e-2", text: "Kévin aime le café serré", pinned: false, createdAt: 1_783_900_000_000, recallCount: 0, lastRecalledAt: null },
    ]);
    const rules = join(dir, "regles.json");
    writeFileSync(rules, JSON.stringify({ regles: [{ id: "a1b2c", texte: "Pas plus de 20 °C", cree_le: "2026-07-22T10:00:00", par: "pwa" }] }));
    expect(readAliceRules(rules)).toEqual([{ key: "alice:rule:a1b2c", text: "Pas plus de 20 °C", createdAt: Date.parse("2026-07-22T10:00:00") }]);
  });

  test("imports into common, idempotently", async () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-import-"));
    const chroma = join(dir, "chroma.sqlite3");
    fakeChroma(chroma);
    const store = new MemoryStore(createTestDb(), new FakeEmbedder(), createTestClock().clock, { duplicateThreshold: 0.95, minSimilarity: 0.3 });
    const source = { memories: readAliceMemories(chroma), rules: [{ key: "alice:rule:x", text: "Pas plus de 20 °C", createdAt: 0 }] };
    expect(await importAlice(store, source)).toEqual({ created: 3, duplicates: 0, skipped: 0 });
    expect(await importAlice(store, source)).toEqual({ created: 0, duplicates: 0, skipped: 3 });
    const all = store.list("elodie", {});
    expect(all.every((m) => m.scope === "common")).toBe(true);
    expect(all.find((m) => m.text === "Pas plus de 20 °C")).toMatchObject({ kind: "rule", pinned: true });
    expect(all.find((m) => m.text === "Le chat s'appelle Moka")).toMatchObject({ kind: "fact", pinned: true, recallCount: 6 });
  });
});
```

- [ ] **Step 2: Écrire l'import**

`apps/brain/src/memory/import-alice.ts` :
```ts
import { readFileSync } from "node:fs";
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

/** Reads the old Alice's Chroma database (read-only) without Chroma itself. */
export function readAliceMemories(chromaPath: string): AliceMemory[] {
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
            createdAt: (row.created ?? 0) * 1000,
            recallCount: row.hits ?? 0,
            lastRecalledAt: row.last_recalled === null ? null : row.last_recalled * 1000,
          }],
    );
  } finally {
    db.close();
  }
}

export function readAliceRules(rulesPath: string): AliceRule[] {
  const file = RulesFile.parse(JSON.parse(readFileSync(rulesPath, "utf8")));
  return file.regles.map((rule) => ({
    key: `alice:rule:${rule.id}`,
    text: rule.texte.trim(),
    createdAt: Date.parse(rule.cree_le),
  }));
}

export interface ImportReport {
  created: number;
  duplicates: number;
  skipped: number;
}

/** Imports everything into the household (common) memory. Safe to run again: already imported keys are skipped. */
export async function importAlice(
  store: MemoryStore,
  source: { memories: readonly AliceMemory[]; rules: readonly AliceRule[] },
): Promise<ImportReport> {
  const report: ImportReport = { created: 0, duplicates: 0, skipped: 0 };
  const items = [
    ...source.rules.map((rule) => ({ ...rule, kind: "rule" as const, pinned: true, recallCount: 0, lastRecalledAt: null })),
    ...source.memories.map((memory) => ({ ...memory, kind: "fact" as const })),
  ];
  for (const item of items) {
    if (store.hasImportKey(item.key)) {
      report.skipped++;
      continue;
    }
    // Any person id works for "common"; the first configured person is passed by the CLI.
    const result = await store.remember({
      personId: "import", scope: "common", kind: item.kind, text: item.text, source: "import", pinned: item.pinned,
      importKey: item.key, createdAt: item.createdAt, recallCount: item.recallCount, lastRecalledAt: item.lastRecalledAt,
    });
    if (result.status === "created") report.created++;
    else report.duplicates++;
  }
  return report;
}
```
Note : un doublon pendant l'import n'enregistre pas la clé ; une relance le recompterait en « duplicates ». Acceptable (rien n'est créé deux fois).

- [ ] **Step 3: Commande**

Dans `apps/brain/src/cli.ts`, ajouter `import-alice --chroma <chemin> [--rules <chemin>]` : ouvre l'application (config + base, **sans** démarrer le serveur), construit le `MemoryStore` avec le vrai embedder, appelle `importAlice`, affiche « Import : N créés, N doublons, N déjà importés. » ; ajouter la ligne à l'aide.

- [ ] **Step 4: Tests puis commit**

Run: `pnpm test && pnpm typecheck && pnpm lint` → PASS.
```bash
git add apps/brain/src/memory/import-alice.ts apps/brain/src/cli.ts apps/brain/test/import-alice.test.ts
git commit -m "feat(brain): idempotent import of the old Alice's memories and house rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Assemblage, app de bureau et vérification réelle

**Files:**
- Modify: `apps/brain/src/application.ts`, `apps/brain/src/cli.ts`, `apps/desktop/e2e/app.e2e.ts`, `README.md`
- Create: `apps/desktop/src/renderer/src/lib/tool-labels.ts` ; Modify: `apps/desktop/src/renderer/src/lib/chat-store.svelte.ts`
- Test: `apps/brain/test/application.test.ts`, `apps/desktop/test/chat-store.test.ts`

- [ ] **Step 1: Assemblage du cerveau**

`buildApplication(config, engine, options)` : `ApplicationOptions` gagne `embedder?: Embedder` (défaut : `new TransformersEmbedder(join(config.dataDir, "models"))`, chargé à la première utilisation seulement). Construire `MemoryStore`, le passer au chat et au serveur, et appeler `memory.purgeForgotten()` au démarrage. `Application` expose `memory`. Le test d'assemblage et l'e2e de l'app passent `embedder: new FakeEmbedder()` (aucun téléchargement en test).

- [ ] **Step 2: Libellés des outils dans l'app (test d'abord)**

Dans `apps/desktop/test/chat-store.test.ts` :
```ts
test.each([
  ["memory_search", "Alicia fouille dans sa mémoire…"],
  ["memory_remember", "Alicia retient ça…"],
  ["memory_update", "Alicia met sa mémoire à jour…"],
  ["memory_forget", "Alicia oublie ce souvenir…"],
  ["weather", "Alicia utilise l'outil « weather »…"],
])("tool %s → activity label", (tool, label) => {
  const { store } = setup();
  store.send("x");
  store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool });
  expect(store.activity).toBe(label);
});
```
`apps/desktop/src/renderer/src/lib/tool-labels.ts` :
```ts
const LABELS: Readonly<Record<string, string>> = {
  memory_search: "Alicia fouille dans sa mémoire…",
  memory_remember: "Alicia retient ça…",
  memory_update: "Alicia met sa mémoire à jour…",
  memory_forget: "Alicia oublie ce souvenir…",
};

export function toolActivity(tool: string): string {
  return LABELS[tool] ?? `Alicia utilise l'outil « ${tool} »…`;
}
```
Dans `ChatStore.handle`, cas `tool_call` : `this.activity = toolActivity(event.tool);` et mascotte `idea` pour `memory_remember` (sinon `thinking`).

- [ ] **Step 3: Documentation**

README : section « Mémoire » — premier démarrage (téléchargement du modèle ~120 Mo dans `data/models`), import (`pnpm exec tsx src/cli.ts import-alice --chroma <…>/data/memory/chroma.sqlite3 --rules <…>/data/regles.json`, à lancer **sur le Pi** contre les données de production de l'ancienne Alice, ou sur une copie), API `/memories`.

- [ ] **Step 4: Tests**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e` → PASS.

- [ ] **Step 5: Vérification réelle (manuelle, avec Kévin — consomme un peu de quota)**

1. Démarrer le cerveau (`cd apps/brain && pnpm exec tsx --env-file=.env src/cli.ts start`) : le premier usage de la mémoire télécharge le modèle.
2. Dans l'app : « Retiens que mon plat préféré, ce sont les lasagnes. » → l'activité affiche « Alicia retient ça… », la mascotte a une idée.
3. **Nouvelle conversation** : « Quel est mon plat préféré ? » → Alicia cherche dans sa mémoire et répond « les lasagnes ».
4. Appairer l'app d'Élodie (ou une 2ᵉ session appairée à `elodie`) : « Quel est le plat préféré de Kévin ? » → elle ne le sait pas (souvenir personnel de Kévin).
5. Ajuster si besoin `duplicateThreshold` / `minSimilarity` (valeurs e5) d'après ce qui est observé, avec un test qui fige le choix.

- [ ] **Step 6: Commit**

```bash
git add apps/brain/src/application.ts apps/brain/src/cli.ts apps/brain/test/application.test.ts apps/desktop/e2e/app.e2e.ts apps/desktop/src/renderer/src/lib/tool-labels.ts apps/desktop/src/renderer/src/lib/chat-store.svelte.ts apps/desktop/test/chat-store.test.ts README.md
git commit -m "feat: memory wired end to end (embedder, purge, import command, activity labels)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Couverture de la spec par ce plan

| Exigence (spec, section Mémoire) | Tâche |
|---|---|
| Souvenir : texte, portée, type, provenance, dates, compteur, épinglé | 1, 4 |
| Recherche hybride mots-clés + sens, filtrée par portée avant classement | 1, 3, 4 |
| Embeddings locaux multilingues, sans quota | 2 |
| Outils `chercher` / `retenir` / `corriger` / `oublier` | 6, 7 |
| Mémoire autonome (retenir d'office), doute → perso | 5, 7 |
| Cloisonnement garanti par le code | 4, 7, 8 |
| Fiche permanente plafonnée (~2 000 tokens) | 4, 5 |
| Import de l'ancienne Alice (souvenirs + règles), commun, idempotent | 9 |
| Tri assisté (proposer de déplacer commun → perso) | 7 (`memory_update` avec `scope`) |
| API pour l'écran Souvenirs | 8 |
| Index SQLite notés aux relectures du plan 1 | 1 |
