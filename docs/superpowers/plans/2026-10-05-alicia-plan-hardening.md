# Alicia — Plan « Durcissement » du cerveau — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre le cerveau robuste pour un usage quotidien : requêtes indexées, journal tourné à 90 jours, sauvegarde nocturne, erreurs HTTP typées et partagées, appairage protégé par adresse, origines web contrôlées (HTTP et WebSocket), connexions mortes détectées des deux côtés, contre-pression sur le WebSocket, et une reprise de session SDK qui ne s'efface plus sur une simple panne réseau.

**Architecture:** Aucune nouvelle dépendance. Côté base : une migration Drizzle d'index, une méthode de rotation dans `ConversationRepository`, un module `db/backup.ts` (API de sauvegarde en ligne de SQLite via `better-sqlite3`) et un planificateur `Maintenance` à horloge injectée. Côté moteur : un code d'erreur interne `unreadable_session` et une fin de tour silencieuse transformée en erreur. Côté serveur : un schéma d'erreur HTTP dans `@alicia/protocol` (`HttpErrorBody`) et ses aides `http-errors.ts`, un `FailureLimiter` par adresse, un crochet `onRequest` d'origine commun à HTTP et à la mise à niveau WebSocket, un battement de cœur (ping protocolaire + événement `heartbeat`) et une attente de vidage (`waitForDrain`). Côté app : `brain-client.ts` lit les erreurs typées, `ChatConnection` abandonne une connexion muette et se reconnecte.

**Spec :** `docs/superpowers/specs/2026-10-04-alicia-socle-design.md`, sections « Erreurs » (session illisible, journal), « Déploiement » (sauvegarde), « Réseau et identités » (appairage).

**Tech Stack:** celle du dépôt (TypeScript ~6.0.3 strict, Zod 4, Fastify 5 + `@fastify/websocket` 11 + `@fastify/cors` 11, `ws` 8.22, Drizzle 0.45 + better-sqlite3 13, `@anthropic-ai/claude-agent-sdk` 0.3.288, Electron 44 + Svelte 5, Vitest 5, Playwright `_electron`).

---

## Règles impératives (à lire avant la tâche 1)

- **TypeScript ultra-strict** : pas d'`any`, pas d'assertion de type dans `src/`, pas de règle de lint désactivée ; **Zod à chaque frontière** (corps HTTP, messages WebSocket, config, réponses lues par l'app).
- **Code, identifiants, commentaires et messages de commit en anglais** ; **textes vus par la famille en français** (messages d'erreur HTTP et WebSocket, sorties de la CLI, README).
- Imports relatifs avec extension `.ts`. Champs privés `#champ`, pas de propriétés de paramètres, pas d'`enum`. Le temps est injecté (`Clock`, `schedule`/`every`) : aucun test n'attend une vraie heure.
- **Ne jamais toucher** `apps/brain/.env`, `apps/brain/alicia.config.yaml`, `apps/brain/data/`, ni quoi que ce soit sous `C:\Sources\alice`. **Ne jamais utiliser le port 8780** (le vrai cerveau de Kévin y tourne) : les tests écoutent sur le port 0, les vérifications manuelles utilisent une config temporaire.
- **Jamais `git add -A` ni `git add .`** : ajouter les fichiers par chemin explicite (un dossier précis comme `apps/brain/drizzle` est accepté).
- **Commit seulement si `pnpm test`, `pnpm typecheck` et `pnpm lint` sont verts**, plus `pnpm --filter @alicia/desktop test:e2e` quand la tâche touche l'app de bureau ou ce qu'elle consomme (tâches 6, 8, 10, 15). Messages de commit en anglais, terminés par la ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Dépendances** : ce plan n'en ajoute aucune. Si un exécutant en ajoute malgré tout, prendre la dernière version stable **en respectant la politique `minimumReleaseAge` de pnpm** : ne jamais ajouter `minimumReleaseAgeExclude` ; si la version la plus récente est trop fraîche, prendre la précédente.
- **Fins de ligne** : la plupart des fichiers du dépôt sont en CRLF (certains mélangent). Les modifications doivent **préserver les fins de ligne existantes** de chaque fichier ; les nouveaux fichiers suivent la convention de leur dossier (CRLF dans `apps/` et `packages/`).
- TDD : test d'abord, le voir échouer, implémenter, le voir passer. Lire le code réel avant d'écrire : les noms ci-dessous correspondent à `feat/hardening` @ `2ebb730`. En cas d'écart, s'aligner sur le code et le signaler.

## État vérifié avant d'écrire ce plan

- **Index déjà en place** (migration `0001`) : `conversations_person_updated_idx (person_id, updated_at)`, `messages_conversation_created_idx (conversation_id, created_at)`, `memories_scope_idx (scope, forgotten_at)`, et l'unique `devices_token_hash_unique`. La tâche 1 ne les recrée pas ; elle les **vérifie par `EXPLAIN QUERY PLAN`** et ajoute les index manquants : `turn_log (conversation_id)`, `turn_log (created_at)`, `memories (conversation_id)` (suppression d'une conversation : `ON DELETE SET NULL` et la clé étrangère de `turn_log` parcourent sinon toute la table).
- **Le journal existe** : table `turn_log`, écrite par `ConversationRepository.logTurn`. **Aucune rotation** n'existe : tâche 2.
- **Appairage** : `PairingService.redeem` limite déjà à 5 échecs par minute, **globalement** (un attaquant peut donc bloquer toute la maison). La tâche 7 ajoute une limite **par adresse** et garde la limite globale en filet.
- **WebSocket** : aucune vérification d'origine aujourd'hui (les navigateurs n'appliquent pas CORS aux WebSockets), aucun battement de cœur, envoi sans regarder `bufferedAmount`.
- **Session SDK** : `handleSend` efface la session sur **toute** erreur `engine` sans texte ni outil (une coupure réseau suffit). Le SDK 0.3.288 relaie l'échec de `resume` sous la forme `Claude Code process exited with code 1. stderr: No conversation found with session ID: <id>` (chaîne relevée dans `claude.exe` du paquet `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.288` et dans `getProcessExitError` de `sdk.mjs`).
- **`done` à 0 token** : `translateTurn` ne produit rien quand le flux du SDK se termine sans message `result` ni exception ; `handleSend` envoie alors un `done` à 0 token.

## Décisions prises dans ce plan

- **Battement applicatif en plus du ping protocolaire** : le ping/pong `ws` détecte un client mort côté cerveau, mais un navigateur ne voit jamais les pings. Le cerveau envoie donc aussi un événement `{ type: "heartbeat" }` (nouveau dans `ServerEvent`) aux connexions authentifiées ; l'app abandonne la connexion après 75 s de silence et se reconnecte. `ChatConnection` filtre ces événements : le reste de l'app ne les voit jamais.
- **Résumé de reprise sans IA** : la spec demande « une nouvelle session amorcée par un résumé de l'historique en base ». Le résumé reste un **extrait déterministe** des derniers échanges (déjà le cas), désormais **borné** (1 000 caractères par message, 8 000 au total, les plus récents d'abord). Un résumé rédigé par le modèle consommerait du quota et pourrait échouer pour la même raison que la session.
- **Limiteur d'appairage maison** (pas `@fastify/rate-limit`) : quelques lignes testables à l'horloge injectée, mémoire bornée. `trustProxy` reste désactivé : derrière un mandataire, toutes les requêtes partagent son adresse et la limite par adresse devient une seconde limite globale (documenté dans le code).
- **Origine `file://`** : en plus de `"null"` (fetch depuis une page `file://`), Chromium envoie `file://` comme `Origin` de la mise à niveau WebSocket. `isAppOrigin` accepte les deux ; l'e2e (app construite chargée en `file://`) tranche.
- **Origine refusée = 403 partout** : un crochet `onRequest` unique refuse toute requête portant une `Origin` hors liste, HTTP comme WebSocket (avant CORS, donc un préflight étranger reçoit aussi 403).
- **Sauvegarde « nocturne »** : un tic par heure ; la sauvegarde du jour local (fuseau `timezone` de la config) se fait au premier tic à partir de 3 h, une seule fois par jour (le fichier du jour fait foi, donc un redémarrage ne la refait pas) ; au démarrage, un tic de rattrapage. On garde **les 14 sauvegardes les plus récentes** (et non « 14 jours d'âge » : un cerveau éteint deux semaines ne perd pas toutes ses copies). La rotation du journal se fait dans le même travail.
- **Contre-pression** : au-delà de 256 Kio en attente, la lecture du moteur se met en pause jusqu'au vidage ; après 30 s sans vidage, le tour est annulé et la connexion fermée en 1013 (« réessayer plus tard ») — l'app se reconnecte et resynchronise.

**Hors de ce plan :** résumé de reprise rédigé par le modèle, `trustProxy`/en-têtes `X-Forwarded-For`, chiffrement des sauvegardes, restauration automatisée (procédure manuelle documentée), la PWA elle-même.

## Structure des fichiers

```
packages/protocol/src/
├─ http.ts                         + HttpErrorCode, HttpErrorBody
├─ memory.ts                       + MemoryRefusalReason
└─ server.ts                       + ServerEvent { type: "heartbeat" }
apps/brain/
├─ drizzle/0003_hot_query_indexes.sql (+ meta/)   migration générée
├─ alicia.config.example.yaml      + allowedOrigins (documenté)
└─ src/
   ├─ db/schema.ts                 + index turn_log ×2, memories.conversation_id
   ├─ db/backup.ts                 NOUVEAU : backupDatabase, listBackups, pruneBackups
   ├─ maintenance.ts               NOUVEAU : localTime, Maintenance (tic horaire, travail nocturne)
   ├─ conversations/repository.ts  + purgeTurnLog
   ├─ conversations/chat-service.ts  reprise ciblée, résumé borné, fin silencieuse = erreur
   ├─ engine/engine.ts             + code unreadable_session, INCOMPLETE_TURN_MESSAGE
   ├─ engine/sdk-engine.ts         classifyError (session illisible), translateTurn (fin sans résultat)
   ├─ server/http-errors.ts        NOUVEAU : errorBody, refusedBody, sendError
   ├─ server/failure-limiter.ts    NOUVEAU : FailureLimiter
   ├─ server/backpressure.ts       NOUVEAU : waitForDrain, DEFAULT_DRAIN
   ├─ server/server.ts             erreurs typées, 404, limiteur, origines, options heartbeat/drain
   ├─ server/memory-routes.ts      erreurs typées
   ├─ server/ws.ts                 battement de cœur, contre-pression
   ├─ config.ts                    + allowedOrigins
   ├─ application.ts               + maintenance, allowedOrigins
   └─ cli.ts                       + commande backup, maintenance au démarrage, cas heartbeat
apps/desktop/src/renderer/src/lib/
├─ brain-client.ts                 lit HttpErrorBody
└─ chat-connection.ts              chien de garde du battement
README.md                          commande backup, section « Sauvegardes et journal », origines
```

---

### Task 1: Index des requêtes chaudes

**Files:**
- Modify: `apps/brain/src/db/schema.ts` (tables `turnLog` et `memories`)
- Create (générés) : `apps/brain/drizzle/0003_hot_query_indexes.sql`, `apps/brain/drizzle/meta/0003_snapshot.json` ; Modify (généré) : `apps/brain/drizzle/meta/_journal.json`
- Test: `apps/brain/test/db.test.ts`

- [ ] **Step 1: Écrire le test des plans de requête**

Ajouter à la fin de `apps/brain/test/db.test.ts` (et `describe` à l'import de `vitest`) :
```ts
/** SQLite's plan for a query, one line per step. */
function plan(db: ReturnType<typeof openDb>, query: string, ...params: readonly unknown[]): string {
  return db.$client
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all(...params)
    .map((row) => (row as { detail: string }).detail)
    .join("\n");
}

describe("hot queries use an index", () => {
  test.each([
    ["conversations of a person, most recent first",
      "SELECT id FROM conversations WHERE person_id = ? ORDER BY updated_at DESC", ["kevin"], "conversations_person_updated_idx"],
    ["messages of a conversation, in order",
      "SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at", ["c"], "messages_conversation_created_idx"],
    ["device by token hash", "SELECT id FROM devices WHERE token_hash = ?", ["h"], "devices_token_hash_unique"],
    ["memories in reach", "SELECT id FROM memories WHERE scope = ? AND forgotten_at IS NULL", ["kevin"], "memories_scope_idx"],
    ["memories of a deleted conversation (ON DELETE SET NULL)",
      "SELECT id FROM memories WHERE conversation_id = ?", ["c"], "memories_conversation_idx"],
    ["turn log of a deleted conversation", "SELECT id FROM turn_log WHERE conversation_id = ?", ["c"], "turn_log_conversation_idx"],
    ["turn log rotation", "SELECT id FROM turn_log WHERE created_at < ?", [0], "turn_log_created_idx"],
  ] as const)("%s", (_label, query, params, index) => {
    expect(plan(openDb(":memory:"), query, ...params)).toContain(index);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `pnpm --filter @alicia/brain test db`
Expected: FAIL sur les trois dernières lignes (`memories_conversation_idx`, `turn_log_conversation_idx`, `turn_log_created_idx`) ; les quatre premières passent déjà. Si SQLite choisit un autre libellé de plan pour l'une des quatre premières, aligner l'assertion sur le plan réel (sans supprimer d'index) et le signaler.

- [ ] **Step 3: Déclarer les index dans le schéma**

Dans `apps/brain/src/db/schema.ts`, remplacer la déclaration de `turnLog` par :
```ts
export const turnLog = sqliteTable(
  "turn_log",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull().references(() => conversations.id),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    durationMs: integer("duration_ms").notNull(),
    tools: text("tools").notNull(),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // Deleting a conversation deletes its log (and the foreign key check looks it up).
    index("turn_log_conversation_idx").on(table.conversationId),
    // Rotation beyond 90 days.
    index("turn_log_created_idx").on(table.createdAt),
  ],
);
```
et, dans `memories`, remplacer le troisième argument par :
```ts
  (table) => [
    index("memories_scope_idx").on(table.scope, table.forgottenAt),
    // Deleting a conversation sets its memories' conversation_id to NULL.
    index("memories_conversation_idx").on(table.conversationId),
  ],
```

- [ ] **Step 4: Générer la migration**

Run: `pnpm --filter @alicia/brain migrations --name hot_query_indexes`
Expected: création de `apps/brain/drizzle/0003_hot_query_indexes.sql`, de `meta/0003_snapshot.json`, et mise à jour de `meta/_journal.json`. Le SQL doit contenir **exactement** ces trois instructions (ordre indifférent), rien d'autre (en particulier rien sur `memories_fts`) :
```sql
CREATE INDEX `memories_conversation_idx` ON `memories` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `turn_log_conversation_idx` ON `turn_log` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `turn_log_created_idx` ON `turn_log` (`created_at`);
```
Si drizzle-kit propose autre chose (recréation de table, renommage), s'arrêter et le signaler.

- [ ] **Step 5: Lancer les tests**

Run: `pnpm --filter @alicia/brain test db`
Expected: PASS (Drizzle applique `0003` au démarrage, y compris sur une base existante).

- [ ] **Step 6: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → tout vert.
```bash
git add apps/brain/src/db/schema.ts apps/brain/drizzle apps/brain/test/db.test.ts
git commit -m "perf(brain): index the turn log and memory provenance for deletions and rotation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Rotation du journal au-delà de 90 jours

**Files:**
- Modify: `apps/brain/src/conversations/repository.ts`
- Test: `apps/brain/test/repository.test.ts`

- [ ] **Step 1: Écrire le test**

Dans `apps/brain/test/repository.test.ts`, dans le `describe("ConversationRepository")` :
```ts
  test("turn log rotation drops entries older than 90 days and keeps the rest", () => {
    const { db, time, repository } = createRepository();
    const DAY = 24 * 3_600_000;
    const c = repository.create("kevin", "T");
    const entry = {
      conversationId: c.id, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1, tools: [], error: null,
    } as const;
    repository.logTurn(entry);
    time.advance(89 * DAY);
    repository.logTurn(entry);
    time.advance(2 * DAY); // the first entry is now 91 days old, the second 2 days old
    expect(repository.purgeTurnLog()).toBe(1);
    expect(db.select().from(turnLog).all()).toHaveLength(1);
    expect(repository.purgeTurnLog()).toBe(0);
  });
```

- [ ] **Step 2: Le voir échouer**

Run: `pnpm --filter @alicia/brain test repository`
Expected: FAIL (`purgeTurnLog is not a function` / erreur de type).

- [ ] **Step 3: Implémenter**

Dans `apps/brain/src/conversations/repository.ts` : importer `lt` de `drizzle-orm` (à côté de `and, asc, desc, eq, sql`), ajouter sous les imports :
```ts
/** Spec, « Journal » : turn log entries are kept 90 days. */
export const TURN_LOG_RETENTION_MS = 90 * 24 * 3_600_000;
```
et, après `logTurn` :
```ts
  /** Journal rotation: deletes the turn log entries older than 90 days. Returns how many were deleted. */
  purgeTurnLog(): number {
    return this.#db
      .delete(turnLog)
      .where(lt(turnLog.createdAt, this.#clock() - TURN_LOG_RETENTION_MS))
      .run().changes;
  }
```
(L'appel périodique arrive à la tâche 13.)

- [ ] **Step 4: Lancer les tests**

Run: `pnpm --filter @alicia/brain test repository` → PASS.

- [ ] **Step 5: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert.
```bash
git add apps/brain/src/conversations/repository.ts apps/brain/test/repository.test.ts
git commit -m "feat(brain): turn log rotation beyond 90 days" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Une fin de tour silencieuse est une erreur, jamais un `done` vide

**Files:**
- Modify: `apps/brain/src/engine/engine.ts`, `apps/brain/src/engine/sdk-engine.ts` (`translateTurn`), `apps/brain/src/conversations/chat-service.ts` (`handleSend`)
- Test: `apps/brain/test/sdk-engine.test.ts`, `apps/brain/test/chat-service.test.ts`

Contrat du moteur : **chaque tour se termine par exactement un `done` ou une `error`**, sauf annulation. `translateTurn` l'assure pour le SDK ; `handleSend` l'impose à tout moteur (garde-fou).

- [ ] **Step 1: Écrire les tests du traducteur**

Dans `apps/brain/test/sdk-engine.test.ts`, importer `INCOMPLETE_TURN_MESSAGE` depuis `../src/engine/engine.ts` (en plus du type `EngineEvent`), puis ajouter dans `describe("translateTurn")` :
```ts
  test("stream ends without a result nor an exception → an explicit engine error, never a done", async () => {
    expect(await turn([{ type: "system", subtype: "init", session_id: "s1" }])).toEqual([
      { type: "session", sessionId: "s1" },
      { type: "error", code: "engine", message: INCOMPLETE_TURN_MESSAGE },
    ]);
  });
  test("rejected limit then a silent end → quota", async () => {
    expect(await turn([LIMIT_REJECTED])).toEqual([QUOTA]);
  });
  test("silent end after cancellation: nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await turn([], undefined, controller.signal)).toEqual([]);
  });
```

- [ ] **Step 2: Écrire le test du service**

Dans `apps/brain/test/chat-service.test.ts`, importer `INCOMPLETE_TURN_MESSAGE` depuis `../src/engine/engine.ts` (à côté de `type Engine`) et ajouter dans `describe("handleSend")` :
```ts
  test("an engine that stops without done nor error: engine error, partial text kept, no retry", async () => {
    const { deps, repository, engine, db } = createContext(() => [
      { type: "session", sessionId: "s1" },
      { type: "text", text: "Il fait" },
    ]);
    const events = await send(deps, KEVIN, { text: "Quelle température ?" });
    const id = events[0]?.type === "conversation" ? events[0].conversationId : "";
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "error", requestId: REQUEST_ID, conversationId: id, code: "engine", message: INCOMPLETE_TURN_MESSAGE,
    });
    expect(engine.requests).toHaveLength(1);
    expect(repository.messages(id).map((m) => [m.role, m.text])).toEqual([
      ["user", "Quelle température ?"],
      ["assistant", "Il fait"],
    ]);
    expect(db.select().from(turnLog).all().map((j) => j.error)).toEqual([INCOMPLETE_TURN_MESSAGE]);
  });
```

- [ ] **Step 3: Les voir échouer**

Run: `pnpm --filter @alicia/brain test sdk-engine chat-service`
Expected: FAIL (`INCOMPLETE_TURN_MESSAGE` introuvable, puis `done` à 0 token au lieu de l'erreur).

- [ ] **Step 4: Implémenter**

Dans `apps/brain/src/engine/engine.ts`, après le type `EngineEvent` :
```ts
/** A turn that stopped without a result: an engine failure, never an empty success. */
export const INCOMPLETE_TURN_MESSAGE = "Le moteur s'est arrêté avant la fin de sa réponse.";
```

Dans `apps/brain/src/engine/sdk-engine.ts`, importer `INCOMPLETE_TURN_MESSAGE` (`import { type Engine, type EngineEvent, type EngineRequest, INCOMPLETE_TURN_MESSAGE } from "./engine.ts";`) et remplacer le `try { … } catch { … }` de `translateTurn` par :
```ts
  try {
    for await (const m of messages) {
      if (m.type === "rate_limit_event") {
        if (isBlockingLimit(m.rate_limit_info)) limitRejected = true;
        continue;
      }
      if (m.type === "result") {
        if (resultSeen) continue;
        resultSeen = true;
      }
      for (const e of translateMessage(m)) yield e.type === "error" ? toError(e) : e;
    }
  } catch (cause) {
    if (!resultSeen && !signal.aborted) {
      const text = cause instanceof Error ? cause.message : String(cause);
      yield toError({ type: "error", ...classifyError(text) });
    }
    return;
  }
  // The stream ended quietly without a result: say so, rather than let the turn look like a success.
  if (!resultSeen && !signal.aborted) yield toError({ type: "error", code: "engine", message: INCOMPLETE_TURN_MESSAGE });
```
et compléter le commentaire de `translateTurn` : « Every turn ends with exactly one "done" or one "error", unless cancelled. »

Dans `apps/brain/src/conversations/chat-service.ts` : importer `INCOMPLETE_TURN_MESSAGE` (`import { type Engine, type EngineEvent, INCOMPLETE_TURN_MESSAGE } from "../engine/engine.ts";`). Dans la boucle `for (let attempt …)`, juste après `error = undefined;`, ajouter `let finished = false;` ; dans le `switch`, le cas `done` devient :
```ts
            case "done":
              finished = true;
              inputTokens += e.inputTokens;
              outputTokens += e.outputTokens;
              break;
```
et, juste après le bloc `try { while … } finally { await stream?.return?.(); }` (avant le calcul de `unreadableSession`) :
```ts
      // Every engine must end a turn with "done" or "error": a silent end is a failure, never an empty success.
      if (error === undefined && !finished && !signal.aborted) {
        error = { type: "error", code: "engine", message: INCOMPLETE_TURN_MESSAGE };
      }
```

- [ ] **Step 5: Lancer les tests**

Run: `pnpm --filter @alicia/brain test` → PASS (les tests existants « cancellation… » et « closing the connection mid-turn… » restent verts : l'annulation n'est jamais transformée en erreur).

- [ ] **Step 6: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert.
```bash
git add apps/brain/src/engine/engine.ts apps/brain/src/engine/sdk-engine.ts apps/brain/src/conversations/chat-service.ts apps/brain/test/sdk-engine.test.ts apps/brain/test/chat-service.test.ts
git commit -m "fix(brain): a turn that ends without a result is an engine error, never an empty done" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Session illisible — reprise ciblée et résumé borné

**Files:**
- Modify: `apps/brain/src/engine/engine.ts`, `apps/brain/src/engine/sdk-engine.ts` (`classifyError`), `apps/brain/src/conversations/chat-service.ts` (`buildResumePrompt`, `handleSend`)
- Test: `apps/brain/test/sdk-engine.test.ts`, `apps/brain/test/chat-service.test.ts`

Seul un échec de `resume` (session inconnue ou illisible) efface la session et relance **une** fois sans session, amorcée par l'historique en base. Une panne réseau, un processus qui meurt, une erreur d'API : l'erreur est relayée, **la session est conservée**.

- [ ] **Step 1: Tests du classement**

Dans `apps/brain/test/sdk-engine.test.ts`, dans `describe("classifyError")` :
```ts
  test("resume of an unknown session → unreadable_session", () => {
    expect(
      classifyError("Claude Code process exited with code 1. stderr: No conversation found with session ID: 0b6f2c1e-1111-4222-8333-944455566677"),
    ).toEqual({ code: "unreadable_session", message: "La session précédente est illisible." });
  });
  test("network failures and crashes stay engine errors", () => {
    expect(classifyError("fetch failed: ECONNRESET").code).toBe("engine");
    expect(classifyError("Claude Code process exited with code 1").code).toBe("engine");
  });
```
et dans `describe("translateTurn")` :
```ts
  test("exception from an unreadable session → a single unreadable_session error", async () => {
    expect(await turn([], new Error("Claude Code process exited with code 1. stderr: No conversation found with session ID: abc"))).toEqual([
      { type: "error", code: "unreadable_session", message: "La session précédente est illisible." },
    ]);
  });
```

- [ ] **Step 2: Tests du service**

Dans `apps/brain/test/chat-service.test.ts`, importer `buildResumePrompt` (`import { buildResumePrompt, handleSend } from "../src/conversations/chat-service.ts";`) et le type `Message` (`import { ConversationRepository, type Message } from "../src/conversations/repository.ts";`).

Remplacer, dans le test existant « unreadable session: a single retry, without a session, primed with the history », le deuxième scénario par :
```ts
      () => [{ type: "error", code: "unreadable_session", message: "La session précédente est illisible." }],
```
Puis ajouter dans `describe("handleSend")` :
```ts
  test("a network failure on a resumed session: no retry, the session is kept", async () => {
    const { deps, repository, engine } = createContext(
      SIMPLE_REPLY,
      () => [{ type: "error", code: "engine", message: "Le moteur a échoué : fetch failed" }],
      SIMPLE_REPLY,
    );
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    const events = await send(deps, KEVIN, { text: "Deux", conversationId: id });
    expect(engine.requests).toHaveLength(2);
    expect(repository.get(id, "kevin")?.sessionId).toBe("s1");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "engine", message: "Le moteur a échoué : fetch failed" });
  });

  test("an unreadable session that cannot be retried reaches the app as an engine error", async () => {
    const unreadable: Scenario = () => [
      { type: "error", code: "unreadable_session", message: "La session précédente est illisible." },
    ];
    const { deps, engine } = createContext(SIMPLE_REPLY, unreadable, unreadable);
    const firsts = await send(deps, KEVIN, { text: "Un" });
    const id = firsts[0]?.type === "conversation" ? firsts[0].conversationId : "";
    const events = await send(deps, KEVIN, { text: "Deux", conversationId: id });
    expect(engine.requests).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "engine" });
  });
```
Et un `describe` séparé pour le résumé :
```ts
describe("buildResumePrompt", () => {
  const message = (i: number, text: string): Message => ({
    id: `m${i}`, conversationId: "c", role: i % 2 === 0 ? "user" : "assistant", text, createdAt: i,
  });

  test("no history: the prompt alone", () => {
    expect(buildResumePrompt([], "Bonjour")).toBe("Bonjour");
  });

  test("long messages are cut and the most recent ones are kept within the budget", () => {
    const history = Array.from({ length: 10 }, (_, i) => message(i, `${i}:${"x".repeat(1_500)}`));
    const prompt = buildResumePrompt(history, "Nouveau");
    expect(prompt).toContain("Alicia : 9:");
    expect(prompt).toContain("Utilisateur : 4:");
    expect(prompt).not.toContain("Utilisateur : 0:");
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(9_000);
    expect(prompt.endsWith("Nouveau message :\nNouveau")).toBe(true);
  });
});
```
(Chaque ligne fait au plus 1 014 caractères : 7 lignes tiennent dans 8 000, les messages 3 à 9 sont gardés.)

- [ ] **Step 3: Les voir échouer**

Run: `pnpm --filter @alicia/brain test sdk-engine chat-service`
Expected: FAIL (code inconnu `unreadable_session`, retry sur panne réseau, résumé non borné).

- [ ] **Step 4: Le code d'erreur interne**

Dans `apps/brain/src/engine/engine.ts`, remplacer la dernière variante d'`EngineEvent` par :
```ts
  /**
   * "unreadable_session": the SDK could not resume the requested session (unknown or unreadable).
   * Internal to the brain: the chat service retries without a session and never sends this code to the app.
   */
  | { type: "error"; code: "quota" | "engine" | "unreadable_session"; message: string };
```

- [ ] **Step 5: Le classement**

Dans `apps/brain/src/engine/sdk-engine.ts`, sous `LIMIT_PATTERN` :
```ts
/**
 * What the Claude Code process prints when `resume` names a session it cannot load (strings of the CLI
 * bundled with SDK 0.3.288, relayed by the SDK as "...exited with code 1. stderr: ..."). Re-check on every
 * SDK update, like USAGE_LIMIT_ERROR_PREFIXES.
 */
const UNREADABLE_SESSION_PATTERN = /No conversation found with session ID|--resume session load failed/i;
const UNREADABLE_SESSION_MESSAGE = "La session précédente est illisible.";
```
et remplacer `classifyError` par :
```ts
export function classifyError(text: string): { code: "quota" | "engine" | "unreadable_session"; message: string } {
  // Checked first: a failed resume happens before any API call, so it cannot be a quota problem.
  if (UNREADABLE_SESSION_PATTERN.test(text)) return { code: "unreadable_session", message: UNREADABLE_SESSION_MESSAGE };
  // USAGE_LIMIT_ERROR_PREFIXES is marked @alpha in the SDK: re-check it on every SDK update.
  const limitReached = LIMIT_PATTERN.test(text) || USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.includes(prefix));
  return limitReached
    ? { code: "quota", message: QUOTA_MESSAGE }
    : { code: "engine", message: `Le moteur a échoué : ${text}` };
}
```

- [ ] **Step 6: Le service**

Dans `apps/brain/src/conversations/chat-service.ts`, sous `RESUME_MESSAGE_COUNT` :
```ts
const RESUME_MESSAGE_CHARS = 1_000;
const RESUME_TOTAL_CHARS = 8_000;

function resumeLine(m: Message): string {
  const text = m.text.length > RESUME_MESSAGE_CHARS ? `${m.text.slice(0, RESUME_MESSAGE_CHARS - 1)}…` : m.text;
  return `${m.role === "user" ? "Utilisateur" : "Alicia"} : ${text}`;
}
```
et remplacer `buildResumePrompt` par :
```ts
/**
 * Primes a new SDK session when the previous one is lost or unreadable (spec, « Erreurs »): the last
 * exchanges stored in the database, each cut to 1,000 characters, the most recent kept first, 8,000 in all.
 */
export function buildResumePrompt(history: readonly Message[], prompt: string): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of [...history].reverse()) {
    const line = resumeLine(m);
    if (total + line.length > RESUME_TOTAL_CHARS) break;
    lines.unshift(line);
    total += line.length;
  }
  if (lines.length === 0) return prompt;
  return `Contexte : la conversation précédente n'a pas pu être reprise. Ses derniers échanges :\n${lines.join("\n")}\n\nNouveau message :\n${prompt}`;
}
```
Dans `handleSend`, remplacer le calcul de `unreadableSession` par :
```ts
      // Only a session the SDK could not load is dropped: a network or process failure keeps it for the next turn.
      const unreadableSession =
        error?.code === "unreadable_session" && sessionId !== undefined && text === "" && loggedTools.length === 0;
```
et l'envoi final de l'erreur par :
```ts
  if (error !== undefined) {
    yield {
      type: "error",
      requestId: message.requestId,
      conversationId,
      // An unreadable session that could not be retried is, for the app, an engine failure.
      code: error.code === "unreadable_session" ? "engine" : error.code,
      message: error.message,
    };
    return;
  }
```

- [ ] **Step 7: Lancer les tests**

Run: `pnpm --filter @alicia/brain test` → PASS.

- [ ] **Step 8: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert.
```bash
git add apps/brain/src/engine/engine.ts apps/brain/src/engine/sdk-engine.ts apps/brain/src/conversations/chat-service.ts apps/brain/test/sdk-engine.test.ts apps/brain/test/chat-service.test.ts
git commit -m "fix(brain): reset the SDK session only when it is really unreadable; bounded resume context" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Erreurs HTTP typées, partagées par le protocole

**Files:**
- Modify: `packages/protocol/src/http.ts`, `packages/protocol/src/memory.ts`
- Create: `apps/brain/src/server/http-errors.ts`
- Modify: `apps/brain/src/server/server.ts`, `apps/brain/src/server/memory-routes.ts`
- Test: `packages/protocol/test/protocol.test.ts`, `apps/brain/test/server-http.test.ts`, `apps/brain/test/server-memories.test.ts`

Forme unique de toute réponse d'erreur HTTP : `{ "error": { "code": "...", "message": "texte français" } }`, plus `reason` pour un souvenir refusé.

- [ ] **Step 1: Test du protocole**

Dans `packages/protocol/test/protocol.test.ts`, ajouter `HttpErrorBody` à l'import puis :
```ts
describe("HTTP errors", () => {
  test("a plain error and a refused memory", () => {
    expect(HttpErrorBody.safeParse({ error: { code: "not_found", message: "Introuvable." } }).success).toBe(true);
    expect(
      HttpErrorBody.safeParse({ error: { code: "refused", message: "Souvenir refusé.", reason: "secret" } }).success,
    ).toBe(true);
  });
  test("a refusal needs its reason; unknown codes and the old flat shape are rejected", () => {
    expect(HttpErrorBody.safeParse({ error: { code: "refused", message: "x" } }).success).toBe(false);
    expect(HttpErrorBody.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
    expect(HttpErrorBody.safeParse({ error: "not_found" }).success).toBe(false);
  });
});
```
Run: `pnpm --filter @alicia/protocol test` → FAIL (`HttpErrorBody` n'existe pas).

- [ ] **Step 2: Schémas du protocole**

Dans `packages/protocol/src/memory.ts`, après `MemorySource` :
```ts
/** Why the brain refused to write a memory: it looked like a secret, or was empty once cleaned. */
export const MemoryRefusalReason = z.enum(["secret", "empty"]);
export type MemoryRefusalReason = z.infer<typeof MemoryRefusalReason>;
```
Dans `packages/protocol/src/http.ts`, importer `MemoryRefusalReason` (`import { MemoryRefusalReason } from "./memory.ts";`) et ajouter à la fin :
```ts
export const HttpErrorCode = z.enum([
  "invalid_request",
  "unauthenticated",
  "not_found",
  "busy",
  "duplicate",
  "refused",
  "invalid_code",
  "too_many_attempts",
  "forbidden_origin",
  "internal",
]);
export type HttpErrorCode = z.infer<typeof HttpErrorCode>;

const RefusedError = z.object({ code: z.literal("refused"), message: z.string(), reason: MemoryRefusalReason });
const PlainError = z.object({ code: HttpErrorCode.exclude(["refused"]), message: z.string() });

/** Body of every HTTP error answer of the brain; `message` is French and may be shown as is. */
export const HttpErrorBody = z.object({ error: z.union([RefusedError, PlainError]) });
export type HttpErrorBody = z.infer<typeof HttpErrorBody>;
```
Run: `pnpm --filter @alicia/protocol test` → PASS.

- [ ] **Step 3: Aides côté cerveau**

Créer `apps/brain/src/server/http-errors.ts` :
```ts
import type { HttpErrorBody, HttpErrorCode, MemoryRefusalReason } from "@alicia/protocol";
import type { FastifyReply } from "fastify";

export type PlainErrorCode = Exclude<HttpErrorCode, "refused">;

/** French on purpose: the app may show them to the family as they are. */
const MESSAGES: Readonly<Record<HttpErrorCode, string>> = {
  invalid_request: "Requête invalide.",
  unauthenticated: "Appareil non reconnu : il faut l'appairer à nouveau.",
  not_found: "Introuvable.",
  busy: "Alicia répond déjà dans cette conversation.",
  duplicate: "Ce souvenir existe déjà.",
  refused: "Souvenir refusé.",
  invalid_code: "Code d'appairage invalide ou expiré.",
  too_many_attempts: "Trop d'essais : réessaie dans quelques minutes.",
  forbidden_origin: "Origine non autorisée.",
  internal: "Erreur interne du cerveau.",
};

export function errorBody(code: PlainErrorCode): HttpErrorBody {
  return { error: { code, message: MESSAGES[code] } };
}

export function refusedBody(reason: MemoryRefusalReason): HttpErrorBody {
  return { error: { code: "refused", message: MESSAGES.refused, reason } };
}

/** Sends a typed error; returns the reply so a handler can `return sendError(...)`. */
export function sendError(reply: FastifyReply, status: number, code: PlainErrorCode): FastifyReply {
  return reply.code(status).send(errorBody(code));
}
```

- [ ] **Step 4: Adapter les tests du serveur (d'abord)**

Dans `apps/brain/test/server-http.test.ts`, importer `HttpErrorBody` de `@alicia/protocol` et `errorBody` de `../src/server/http-errors.ts`. Remplacer les quatre assertions à l'ancienne forme :
- `expect(res.json()).toEqual({ error: "invalid_request" });` (deux fois) → `expect(res.json()).toEqual(errorBody("invalid_request"));`
- `expect(res.json()).toEqual({ error: "internal" });` → `expect(res.json()).toEqual(errorBody("internal"));`
- `expect(busy.json()).toEqual({ error: "busy" });` → `expect(busy.json()).toEqual(errorBody("busy"));`

Ajouter dans `describe("HTTP server")` :
```ts
  test("every error answer follows the shared schema, unknown routes included", async () => {
    const ctx = await createContext();
    const token = await pair(ctx, "kevin");
    const busy = ctx.repository.create("kevin", "Occupée");
    expect(ctx.locks.acquire("kevin", busy.id)).toBe(true);
    const answers = [
      await ctx.app.inject({ method: "GET", url: "/conversations" }),
      await ctx.app.inject({ method: "POST", url: "/pairing", payload: { code: "abc" } }),
      await ctx.app.inject({ method: "POST", url: "/pairing", payload: { code: "000000", deviceName: "PC" } }),
      await ctx.app.inject({ method: "GET", url: "/nowhere" }),
      await ctx.app.inject({
        method: "DELETE", url: `/conversations/${busy.id}`, headers: { authorization: `Bearer ${token}` },
      }),
    ];
    expect(answers.map((a) => [a.statusCode, HttpErrorBody.parse(a.json()).error.code])).toEqual([
      [401, "unauthenticated"],
      [400, "invalid_request"],
      [401, "invalid_code"],
      [404, "not_found"],
      [409, "busy"],
    ]);
    for (const a of answers) expect(HttpErrorBody.parse(a.json()).error.message).not.toBe("");
  });
```
Dans `apps/brain/test/server-memories.test.ts`, importer `errorBody, refusedBody` de `../src/server/http-errors.ts` et remplacer les cinq assertions :
- `{ error: "duplicate" }` → `errorBody("duplicate")`
- `{ error: "refused", reason: "secret" }` (deux fois) → `refusedBody("secret")`
- `{ error: "not_found" }` (deux fois) → `errorBody("not_found")`

Run: `pnpm --filter @alicia/brain test server-http server-memories` → FAIL (anciennes formes, 404 de route au format Fastify).

- [ ] **Step 5: Brancher le serveur**

Dans `apps/brain/src/server/server.ts`, importer `import { sendError } from "./http-errors.ts";` puis :
- gestionnaire d'erreurs :
```ts
  app.setErrorHandler((error, request, reply) => {
    const status = clientStatus(error);
    if (status !== undefined) {
      request.log.warn({ status }, "request rejected");
      return sendError(reply, status, "invalid_request");
    }
    request.log.error({ err: error }, "internal error");
    return sendError(reply, 500, "internal");
  });
  // Unknown routes answer in the same shape as everything else.
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, "not_found"));
```
- `/pairing` :
```ts
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const result = deps.pairing.redeem(body.data.code, body.data.deviceName);
    if ("error" in result) return sendError(reply, result.error === "too_many_attempts" ? 429 : 401, result.error);
    return result;
```
- partout ailleurs : `reply.code(401).send({ error: "unauthenticated" })` → `sendError(reply, 401, "unauthenticated")`, `reply.code(404).send({ error: "not_found" })` → `sendError(reply, 404, "not_found")`, `reply.code(409).send({ error: "busy" })` → `sendError(reply, 409, "busy")`.

Dans `apps/brain/src/server/memory-routes.ts`, importer `import { refusedBody, sendError } from "./http-errors.ts";` et remplacer **chaque** `reply.code(N).send({ error: "x" })` par `sendError(reply, N, "x")` (codes `unauthenticated`, `invalid_request`, `duplicate`, `not_found`), et les deux `reply.code(422).send({ error: "refused", reason: result.reason })` par `reply.code(422).send(refusedBody(result.reason))`.

Contrôle : `rg -n "send\(\{ error" apps/brain/src` ne doit plus rien trouver.

- [ ] **Step 6: Lancer les tests**

Run: `pnpm --filter @alicia/brain test` → PASS.

- [ ] **Step 7: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert (l'app de bureau garde ses tests unitaires verts : ils utilisent de faux corps, mis à jour à la tâche 6).
```bash
git add packages/protocol/src/http.ts packages/protocol/src/memory.ts packages/protocol/test/protocol.test.ts apps/brain/src/server/http-errors.ts apps/brain/src/server/server.ts apps/brain/src/server/memory-routes.ts apps/brain/test/server-http.test.ts apps/brain/test/server-memories.test.ts
git commit -m "feat: typed HTTP error body shared by the brain and its clients" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Le client de bureau lit les erreurs typées

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/brain-client.ts`
- Test: `apps/desktop/test/brain-client.test.ts`

- [ ] **Step 1: Adapter les faux corps et ajouter les tests**

Dans `apps/desktop/test/brain-client.test.ts`, ajouter sous `MEMORY` :
```ts
/** A typed error body, as the brain sends it. */
const brainError = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "Message du cerveau.", ...extra },
});
```
Remplacer **tous** les corps d'erreur à l'ancienne forme (`rg -n 'error: "' apps/desktop/test/brain-client.test.ts` les liste) :
- `{ error: "invalid_code" }` → `brainError("invalid_code")`, `{ error: "too_many_attempts" }` → `brainError("too_many_attempts")`, `{ error: "invalid_request" }` → `brainError("invalid_request")`
- `{ error: "duplicate" }` → `brainError("duplicate")`, `{ error: "not_found" }` → `brainError("not_found")`, `{ error: "unauthenticated" }` → `brainError("unauthenticated")`, `{ error: "busy" }` → `brainError("busy")`, `{ error: "boom" }` → `brainError("internal")`
- `{ error: "refused", reason: "secret" }` → `brainError("refused", { reason: "secret" })` (idem `empty`, et `weird` qui doit toujours être rejeté)

Puis ajouter dans `describe("pair")` :
```ts
  test("the typed code wins over the status", async () => {
    const { fetchFn } = fakeFetch(400, brainError("too_many_attempts"));
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "too_many_attempts" });
  });
  test("an error body that is not typed falls back on the status", async () => {
    const { fetchFn } = fakeFetch(429, { nope: true });
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "too_many_attempts" });
  });
```
et dans `describe("memories")` :
```ts
    test("createMemory: an unexpected typed error throws with its status and code", async () => {
      await expect(api(409, brainError("busy")).createMemory(input)).rejects.toThrow(/409 \(busy\)/);
    });
    // Old flat shape on purpose (added after the replacement above): an untyped body is never guessed.
    test("createMemory: a 409 without a typed body throws instead of guessing", async () => {
      await expect(api(409, { error: "duplicate" }).createMemory(input)).rejects.toThrow(/409/);
    });
```
Run: `pnpm --filter @alicia/desktop test brain-client` → FAIL (les nouveaux corps ne sont pas lus, messages sans code).

- [ ] **Step 2: Implémenter**

Dans `apps/desktop/src/renderer/src/lib/brain-client.ts` :
- importer `HttpErrorBody` (valeur) de `@alicia/protocol` ; supprimer `MemoryRefusal` (et l'import `z` reste utilisé par `z.array`).
- ajouter sous `FAILURE_BY_STATUS` :
```ts
type BrainError = HttpErrorBody["error"];

/** The brain's typed error, or undefined when the body is not one (older brain, proxy page, empty body…). */
async function readError(response: Response): Promise<BrainError | undefined> {
  try {
    const parsed = HttpErrorBody.safeParse(await response.json());
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

/** The typed code when it is a pairing failure, otherwise the status. */
function pairingFailure(error: BrainError | undefined, status: number): PairingFailure {
  const code = error?.code;
  if (code === "invalid_code" || code === "too_many_attempts" || code === "invalid_request") return code;
  return FAILURE_BY_STATUS[status] ?? "unreachable";
}
```
- dans `pair`, remplacer la ligne `if (!response.ok) return …` par :
```ts
    if (!response.ok) return { ok: false, reason: pairingFailure(await readError(response), response.status) };
```
- remplacer `#writeResult` par :
```ts
  /** Reads the answer of a create or update: the memory, or the reason the brain did not write it. */
  async #writeResult(response: Response, path: string): Promise<MemoryWriteResult> {
    if (response.ok) return { ok: true, memory: MemorySummary.parse(await response.json()) };
    const error = await readError(response);
    if (error === undefined) throw statusError(response.status, path);
    switch (error.code) {
      case "duplicate":
        return { ok: false, reason: "duplicate" };
      case "not_found":
        return { ok: false, reason: "not_found" };
      case "invalid_request":
        return { ok: false, reason: "invalid" };
      case "refused":
        return { ok: false, reason: error.reason };
      default:
        throw statusError(response.status, path, error.code);
    }
  }
```
- remplacer `unexpectedStatus` par :
```ts
function statusError(status: number, path: string, code?: string): Error {
  return new Error(`Brain answered HTTP ${status}${code === undefined ? "" : ` (${code})`} on ${path}`);
}
```
et chaque `throw unexpectedStatus(response, path);` (dans `forgetMemory`, `restoreMemory`, `deleteConversation`, `#get`) par :
```ts
throw statusError(response.status, path, (await readError(response))?.code);
```
(`forgetMemory`, `deleteConversation` et `restoreMemory` gardent leur lecture par statut pour 204/404/409 : elle reste juste avec les corps typés.)

- [ ] **Step 3: Lancer les tests**

Run: `pnpm --filter @alicia/desktop test` → PASS.

- [ ] **Step 4: Vérifier (e2e compris) et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e` → vert (« a wrong pairing code is explained » lit désormais le code typé).
```bash
git add apps/desktop/src/renderer/src/lib/brain-client.ts apps/desktop/test/brain-client.test.ts
git commit -m "feat(desktop): brain client reads typed HTTP errors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Limite d'appairage par adresse

**Files:**
- Create: `apps/brain/src/server/failure-limiter.ts`
- Modify: `apps/brain/src/server/server.ts` (route `/pairing`)
- Test: `apps/brain/test/failure-limiter.test.ts` (nouveau), `apps/brain/test/server-http.test.ts`

Un code à 6 chiffres = 1 000 000 de possibilités. Par adresse : 5 échecs par 15 minutes, puis 429 (même un bon code est refusé depuis cette adresse). La limite globale de `PairingService` (5 échecs/minute) reste en filet.

- [ ] **Step 1: Tests unitaires du limiteur**

Créer `apps/brain/test/failure-limiter.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { FailureLimiter } from "../src/server/failure-limiter.ts";
import { createTestClock } from "./helpers.ts";

function setup(maxKeys = 100) {
  const time = createTestClock();
  const limiter = new FailureLimiter({ clock: time.clock, windowMs: 60_000, maxFailures: 3, maxKeys });
  return { time, limiter };
}

describe("FailureLimiter", () => {
  test("blocks a key after too many recent failures, and only that key", () => {
    const { limiter } = setup();
    for (let i = 0; i < 2; i++) limiter.fail("10.0.0.1");
    expect(limiter.blocked("10.0.0.1")).toBe(false);
    limiter.fail("10.0.0.1");
    expect(limiter.blocked("10.0.0.1")).toBe(true);
    expect(limiter.blocked("10.0.0.2")).toBe(false);
  });

  test("failures older than the window are forgotten", () => {
    const { time, limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.fail("10.0.0.1");
    time.advance(60_000);
    expect(limiter.blocked("10.0.0.1")).toBe(false);
  });

  test("memory stays bounded: the key that failed least recently is dropped first", () => {
    const { limiter } = setup(2);
    for (let i = 0; i < 3; i++) limiter.fail("a");
    limiter.fail("b");
    limiter.fail("c");
    expect(limiter.blocked("a")).toBe(false);
  });
});
```
Run: `pnpm --filter @alicia/brain test failure-limiter` → FAIL (module introuvable).

- [ ] **Step 2: Implémenter le limiteur**

Créer `apps/brain/src/server/failure-limiter.ts` :
```ts
import type { Clock } from "../clock.ts";

export interface FailureLimiterOptions {
  clock: Clock;
  /** Failures older than this are forgotten. */
  windowMs: number;
  /** From this many failures within the window, the key is blocked. */
  maxFailures: number;
  /** Keys tracked at most (the one that failed least recently is dropped first): a flood of addresses cannot grow memory. */
  maxKeys: number;
}

/** Counts recent failures per key (an IP address) and blocks a key that failed too often. */
export class FailureLimiter {
  readonly #options: FailureLimiterOptions;
  /** Insertion order = least recently failed first. */
  readonly #failures = new Map<string, number[]>();

  constructor(options: FailureLimiterOptions) {
    this.#options = options;
  }

  blocked(key: string): boolean {
    return this.#recent(key).length >= this.#options.maxFailures;
  }

  fail(key: string): void {
    const recent = this.#recent(key);
    recent.push(this.#options.clock());
    this.#failures.delete(key);
    this.#failures.set(key, recent);
    while (this.#failures.size > this.#options.maxKeys) {
      const oldest = this.#failures.keys().next();
      if (oldest.done === true) break;
      this.#failures.delete(oldest.value);
    }
  }

  /** The key's failures still inside the window (expired ones are dropped on the way). */
  #recent(key: string): number[] {
    const now = this.#options.clock();
    const recent = (this.#failures.get(key) ?? []).filter((t) => now - t < this.#options.windowMs);
    if (recent.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, recent);
    return recent;
  }
}
```
Run: `pnpm --filter @alicia/brain test failure-limiter` → PASS.

- [ ] **Step 3: Test de la route**

Dans `apps/brain/test/server-http.test.ts`, faire renvoyer `time` par `createContext` (`return { app, pairing, repository, locks, time };`) puis ajouter dans `describe("HTTP server")` :
```ts
  test("POST /pairing: an address that keeps failing is blocked, the others are not", async () => {
    const ctx = await createContext();
    const attempt = (remoteAddress: string, code = "000000") =>
      ctx.app.inject({ method: "POST", url: "/pairing", remoteAddress, payload: { code, deviceName: "PC" } });

    for (let i = 0; i < 5; i++) expect((await attempt("10.0.0.1")).statusCode).toBe(401);
    // Even a valid code is refused from this address now.
    const blocked = await attempt("10.0.0.1", ctx.pairing.generateCode("kevin"));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual(errorBody("too_many_attempts"));

    // Past the global one-minute limit, another address pairs normally; the first one is still blocked.
    ctx.time.advance(61_000);
    expect((await attempt("10.0.0.2", ctx.pairing.generateCode("kevin"))).statusCode).toBe(200);
    expect((await attempt("10.0.0.1", ctx.pairing.generateCode("kevin"))).statusCode).toBe(429);

    // After 15 minutes, the first address may try again.
    ctx.time.advance(15 * 60_000);
    expect((await attempt("10.0.0.1", ctx.pairing.generateCode("kevin"))).statusCode).toBe(200);
  });
```
Run: `pnpm --filter @alicia/brain test server-http` → FAIL (401 au lieu de 429 sur la sixième tentative).

- [ ] **Step 4: Brancher la route**

Dans `apps/brain/src/server/server.ts`, importer `import { FailureLimiter } from "./failure-limiter.ts";`, ajouter sous `BEARER` :
```ts
const PAIRING_FAILURE_WINDOW_MS = 15 * 60_000;
const PAIRING_MAX_FAILURES = 5;
const PAIRING_MAX_ADDRESSES = 1_000;
```
et remplacer la route `/pairing` par :
```ts
  // Per address, on top of PairingService's global limit: one machine guessing codes is stopped without
  // locking the whole household out. trustProxy is off on purpose: behind a reverse proxy every request
  // shares the proxy's address, and this becomes a second global limit.
  const pairingFailures = new FailureLimiter({
    clock: deps.chat.clock,
    windowMs: PAIRING_FAILURE_WINDOW_MS,
    maxFailures: PAIRING_MAX_FAILURES,
    maxKeys: PAIRING_MAX_ADDRESSES,
  });

  app.post("/pairing", (request, reply) => {
    if (pairingFailures.blocked(request.ip)) return sendError(reply, 429, "too_many_attempts");
    const body = PairingRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const result = deps.pairing.redeem(body.data.code, body.data.deviceName);
    if ("error" in result) {
      if (result.error === "invalid_code") pairingFailures.fail(request.ip);
      return sendError(reply, result.error === "too_many_attempts" ? 429 : 401, result.error);
    }
    return result;
  });
```

- [ ] **Step 5: Lancer les tests**

Run: `pnpm --filter @alicia/brain test` → PASS.

- [ ] **Step 6: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert.
```bash
git add apps/brain/src/server/failure-limiter.ts apps/brain/src/server/server.ts apps/brain/test/failure-limiter.test.ts apps/brain/test/server-http.test.ts
git commit -m "feat(brain): per-address limit on pairing attempts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Origines autorisées (CORS et WebSocket) pilotées par la config

**Files:**
- Modify: `apps/brain/src/config.ts`, `apps/brain/src/server/server.ts`, `apps/brain/src/application.ts`, `apps/brain/alicia.config.example.yaml`
- Test: `apps/brain/test/config.test.ts`, `apps/brain/test/server-http.test.ts`, `apps/brain/test/server-ws.test.ts`

- [ ] **Step 1: Test de la config**

Dans `apps/brain/test/config.test.ts`, dans `describe("parseConfig")` :
```ts
  test("allowedOrigins: none by default, exact origins only", () => {
    expect(parseConfig(MINIMAL_YAML).allowedOrigins).toEqual([]);
    expect(parseConfig(`${MINIMAL_YAML}allowedOrigins: ["https://alicia.tailnet.ts.net"]\n`).allowedOrigins).toEqual([
      "https://alicia.tailnet.ts.net",
    ]);
    expect(() => parseConfig(`${MINIMAL_YAML}allowedOrigins: ["https://alicia.tailnet.ts.net/"]\n`)).toThrow(/Origine invalide/);
    expect(() => parseConfig(`${MINIMAL_YAML}allowedOrigins: ["*"]\n`)).toThrow(/Origine invalide/);
    expect(() => parseConfig(`${MINIMAL_YAML}allowedOrigins: ["ftp://alicia.lan"]\n`)).toThrow(/Origine invalide/);
  });
```

- [ ] **Step 2: Tests HTTP**

Dans `apps/brain/test/server-http.test.ts` :
- `createContext` prend des options et les passe au serveur :
```ts
async function createContext(options: { allowedOrigins?: readonly string[] } = {}) {
  // … inchangé jusqu'à createServer :
  const app = await createServer({
    locks, pairing, repository, version: "0.1.0", chat: {
      repository, engine, memory: createTestMemory(db, time.clock), clock: time.clock, timezone: "Europe/Paris",
    },
    ...(options.allowedOrigins !== undefined ? { allowedOrigins: options.allowedOrigins } : {}),
  });
```
- importer `isAllowedOrigin` de `../src/server/server.ts`.
- dans le `describe("CORS…")` : ajouter `"file://"` à la liste des origines autorisées du `test.each` ; le test des origines refusées devient :
```ts
  test.each(["https://evil.example", "http://localhost.evil.example", "http://192.168.1.50:5173"])(
    "refused origin %s: 403, no CORS header",
    async (origin) => {
      const { app } = await createContext();
      const response = await app.inject(preflight(origin));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(errorBody("forbidden_origin"));
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    },
  );

  test("a configured origin (future PWA) is allowed, exactly", async () => {
    const { app } = await createContext({ allowedOrigins: ["https://alicia.tailnet.ts.net"] });
    const ok = await app.inject(preflight("https://alicia.tailnet.ts.net"));
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://alicia.tailnet.ts.net");
    expect((await app.inject(preflight("https://alicia.tailnet.ts.net.evil.example"))).statusCode).toBe(403);
  });

  test("a foreign page cannot even read the health check", async () => {
    const { app } = await createContext();
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(errorBody("forbidden_origin"));
  });
```
- et un `describe` pour le prédicat :
```ts
describe("isAllowedOrigin", () => {
  const extra = new Set(["https://alicia.tailnet.ts.net"]);
  test.each([undefined, "null", "file://", "http://localhost:5173", "http://127.0.0.1:4173", "https://alicia.tailnet.ts.net"])(
    "allows %s",
    (origin) => {
      expect(isAllowedOrigin(origin, extra)).toBe(true);
    },
  );
  test.each(["https://evil.example", "https://alicia.tailnet.ts.net.evil.example", "http://alicia.tailnet.ts.net", "http://192.168.1.50:5173"])(
    "refuses %s",
    (origin) => {
      expect(isAllowedOrigin(origin, extra)).toBe(false);
    },
  );
});
```

- [ ] **Step 3: Test WebSocket**

Dans `apps/brain/test/server-ws.test.ts`, ajouter `allowedOrigins?: readonly string[]` à `StartOptions` et le passer à `createServer` (`...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins })`). Ajouter sous `connect` :
```ts
/** Opens a socket with an Origin header: "open" when accepted, otherwise the HTTP status of the refused upgrade. */
function tryOrigin(url: string, origin: string): Promise<number | "open"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin });
    ws.once("open", () => {
      resolve("open");
      ws.close();
    });
    ws.once("unexpected-response", (request, response) => {
      resolve(response.statusCode ?? 0);
      request.destroy();
    });
    ws.on("error", () => undefined);
  });
}
```
et dans `describe("WebSocket")` :
```ts
  test("a foreign Origin is refused before the upgrade; the app's and configured ones are accepted", async () => {
    const { url } = await start({ allowedOrigins: ["https://alicia.tailnet.ts.net"] });
    expect(await tryOrigin(url, "https://evil.example")).toBe(403);
    expect(await tryOrigin(url, "file://")).toBe("open");
    expect(await tryOrigin(url, "null")).toBe("open");
    expect(await tryOrigin(url, "https://alicia.tailnet.ts.net")).toBe("open");
  });
```
Run: `pnpm --filter @alicia/brain test config server-http server-ws` → FAIL.

- [ ] **Step 4: La config**

Dans `apps/brain/src/config.ts`, au-dessus de `ConfigSchema` :
```ts
/** An exact web origin: http(s)://host[:port], no path, no trailing slash. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}
```
et dans `ConfigSchema`, après `models` :
```ts
  /** Web pages allowed to call the brain besides the desktop app (the future PWA). None by default. */
  allowedOrigins: z
    .array(z.string().refine(isOrigin, { message: "Origine invalide : écrire schéma://hôte[:port], sans chemin ni barre finale." }))
    .default([]),
```
Dans `apps/brain/alicia.config.example.yaml`, ajouter à la fin :
```yaml
# Pages web autorisées à appeler le cerveau en plus de l'app de bureau (future PWA).
# Origines exactes, sans chemin ni barre finale, ex. "https://alicia.mon-tailnet.ts.net".
allowedOrigins: []
```

- [ ] **Step 5: Le serveur**

Dans `apps/brain/src/server/server.ts` :
```ts
/**
 * Origins of the Alicia desktop app: the packaged app (file:// pages: "null" for fetch, "file://" for the
 * WebSocket upgrade in Chromium) and its local dev server. No Origin at all: CLI, curl, native clients.
 */
export function isAppOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === "null" || origin === "file://" || APP_DEV_ORIGIN.test(origin);
}

/** The app's origins, plus those of the config (`allowedOrigins`). */
export function isAllowedOrigin(origin: string | undefined, extra: ReadonlySet<string>): boolean {
  return isAppOrigin(origin) || (origin !== undefined && extra.has(origin));
}
```
Ajouter à `ServerDependencies` :
```ts
  /** Web origins allowed besides the app's (config `allowedOrigins`). */
  allowedOrigins?: readonly string[];
```
Dans `createServer`, remplacer l'enregistrement de CORS (et son commentaire) par :
```ts
  const extraOrigins: ReadonlySet<string> = new Set(deps.allowedOrigins ?? []);
  const originAllowed = (origin: string | undefined): boolean => isAllowedOrigin(origin, extraOrigins);

  // Browser pages may only call the brain from the Alicia app or a configured origin. Checked here for
  // every request, the WebSocket upgrade included (browsers do not apply CORS to WebSockets), and before
  // CORS so a foreign preflight stops with a 403. Auth still relies on the device token.
  app.addHook("onRequest", (request, reply, done) => {
    if (originAllowed(request.headers.origin)) {
      done();
      return;
    }
    request.log.warn({ origin: request.headers.origin }, "origin refused");
    void sendError(reply, 403, "forbidden_origin");
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, originAllowed(origin));
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });
```
Dans `apps/brain/src/application.ts`, ajouter `allowedOrigins: config.allowedOrigins,` dans l'objet passé à `createServer`.

- [ ] **Step 6: Lancer les tests**

Run: `pnpm --filter @alicia/brain test` → PASS.

- [ ] **Step 7: Vérifier (e2e compris : c'est l'app construite, chargée en `file://`, qui ouvre le WebSocket) et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e` → vert. Si l'e2e échoue sur la connexion, journaliser l'`Origin` reçu (`request.headers.origin`) une fois, l'ajouter à `isAppOrigin` avec un test, et le signaler.
```bash
git add apps/brain/src/config.ts apps/brain/src/server/server.ts apps/brain/src/application.ts apps/brain/alicia.config.example.yaml apps/brain/test/config.test.ts apps/brain/test/server-http.test.ts apps/brain/test/server-ws.test.ts
git commit -m "feat(brain): configurable allowed origins, enforced on HTTP and on the WebSocket upgrade" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Battement de cœur WebSocket côté cerveau

**Files:**
- Modify: `packages/protocol/src/server.ts`, `apps/brain/src/server/ws.ts`, `apps/brain/src/server/server.ts` (`ServerDependencies`), `apps/brain/src/cli.ts` (commande `chat`)
- Test: `packages/protocol/test/protocol.test.ts`, `apps/brain/test/server-ws.test.ts`

- [ ] **Step 1: Test du protocole**

Dans `packages/protocol/test/protocol.test.ts`, dans le `describe` des événements serveur (celui qui teste `ServerEvent`) :
```ts
  test("heartbeat", () => {
    expect(ServerEvent.parse({ type: "heartbeat" })).toEqual({ type: "heartbeat" });
  });
```
Dans `packages/protocol/src/server.ts`, ajouter en tête de la liste de `ServerEvent` :
```ts
  /** Sent every 30 s to authenticated apps: browsers hide protocol pings, this proves the brain is alive. */
  z.object({ type: z.literal("heartbeat") }),
```
Run: `pnpm --filter @alicia/protocol test` → PASS.

- [ ] **Step 2: Tests WebSocket**

Dans `apps/brain/test/server-ws.test.ts`, ajouter `heartbeatMs?: number` à `StartOptions` et le passer à `createServer` (`...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs })`), puis :
```ts
  test("heartbeat: a live app gets heartbeat events and stays connected", async () => {
    const { url, token } = await start({ heartbeatMs: 40 });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(c.received.filter((e) => e.type === "heartbeat").length).toBeGreaterThanOrEqual(2);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  test("heartbeat: a client that stops answering pings is dropped", async () => {
    const { url, token } = await start({ heartbeatMs: 40 });
    const ws = new WebSocket(url, { autoPong: false });
    ws.on("error", () => undefined);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => { resolve(code); }));
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "authenticate", token }));
    });
    expect(await closed).toBe(1006);
  });
```
Run: `pnpm --filter @alicia/brain test server-ws` → FAIL.

- [ ] **Step 3: Implémenter**

Dans `apps/brain/src/server/server.ts`, ajouter à `ServerDependencies` :
```ts
  /** Heartbeat period of the WebSocket (default 30 s; shortened by tests). */
  heartbeatMs?: number;
```
Dans `apps/brain/src/server/ws.ts`, ajouter `const DEFAULT_HEARTBEAT_MS = 30_000;` sous `DEFAULT_AUTH_TIMEOUT_MS`, puis, juste après la création de `timer` :
```ts
  // Heartbeat. Each period, a protocol ping; a socket that left the previous one unanswered is dead
  // (laptop asleep, Wi-Fi gone) and is terminated, which cancels its turns through "close".
  // Authenticated apps also get a "heartbeat" event: browsers hide protocol pings from pages,
  // so this is how the app notices a brain that went silent.
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
    if (session !== undefined) send({ type: "heartbeat" });
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();
```
et `abortTurns` devient :
```ts
  const abortTurns = (): void => {
    clearTimeout(timer);
    clearInterval(heartbeat);
    for (const turn of turns) turn.abort();
  };
```
Dans `apps/brain/src/cli.ts`, dans le `switch (e.type)` de `chat`, ajouter :
```ts
        case "heartbeat":
          break;
```

- [ ] **Step 4: Lancer les tests**

Run: `pnpm --filter @alicia/brain test` → PASS.

- [ ] **Step 5: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert (l'app de bureau reçoit désormais des `heartbeat` qu'elle ignore ; la tâche 10 les exploite).
```bash
git add packages/protocol/src/server.ts packages/protocol/test/protocol.test.ts apps/brain/src/server/ws.ts apps/brain/src/server/server.ts apps/brain/src/cli.ts apps/brain/test/server-ws.test.ts
git commit -m "feat(brain): WebSocket heartbeat drops dead connections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: L'app se reconnecte quand le cerveau se tait

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/chat-connection.ts`, `apps/desktop/src/renderer/src/lib/chat-store.svelte.ts` (cas `heartbeat` explicite)
- Test: `apps/desktop/test/chat-connection.test.ts`

Une fois `ready`, le cerveau parle au moins toutes les 30 s. Après **75 s** sans le moindre message, `ChatConnection` ferme le socket (code 4001), le considère perdu **tout de suite** (sans attendre un `close` que le système peut mettre des minutes à signaler) et planifie la reconnexion habituelle.

- [ ] **Step 1: Adapter l'aide de test et écrire les tests**

Dans `apps/desktop/test/chat-connection.test.ts`, ajouter `const HEARTBEAT_TIMEOUT_MS = 75_000;` sous `READY_TIMEOUT_MS`, et remplacer l'objet `timers` de `setup` par :
```ts
  const timers = {
    /** Reconnect timers only. */
    get retries(): Timer[] {
      return allTimers.filter((t) => t.ms !== READY_TIMEOUT_MS && t.ms !== HEARTBEAT_TIMEOUT_MS);
    },
    /** Ready-timeout timers only. */
    get ready(): Timer[] {
      return allTimers.filter((t) => t.ms === READY_TIMEOUT_MS);
    },
    /** Heartbeat watchdogs only. */
    get heartbeats(): Timer[] {
      return allTimers.filter((t) => t.ms === HEARTBEAT_TIMEOUT_MS);
    },
  };
```
Puis ajouter dans `describe("ChatConnection")` :
```ts
  test("silence after ready: the socket is given up and a reconnect is scheduled at once", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    sockets[0]?.receive(READY);
    expect(timers.heartbeats).toHaveLength(1);
    timers.heartbeats[0]?.run();
    expect(sockets[0]?.closedWith).toBe(4001);
    expect(statuses.at(-1)).toBe("offline");
    expect(connection.send(MESSAGE)).toBe(false);
    expect(timers.retries.map((t) => t.ms)).toEqual([1000]);
    // The late close of the abandoned socket changes nothing.
    sockets[0]?.onclose?.(1006);
    expect(timers.retries).toHaveLength(1);
    timers.retries[0]?.run();
    expect(sockets).toHaveLength(2);
  });

  test("every message re-arms the watchdog; heartbeats are not forwarded", () => {
    const { connection, sockets, timers, events } = setup();
    connection.start();
    sockets[0]?.receive(READY);
    sockets[0]?.receive({ type: "heartbeat" });
    expect(events.map((e) => e.type)).toEqual(["ready"]);
    expect(timers.heartbeats).toHaveLength(2);
    expect(timers.heartbeats[0]?.cancelled).toBe(true);
    expect(timers.heartbeats[1]?.cancelled).toBe(false);
  });

  test("no watchdog before ready; a close or stop cancels it", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    sockets[0]?.receive({ type: "heartbeat" });
    expect(timers.heartbeats).toHaveLength(0);
    sockets[0]?.receive(READY);
    sockets[0]?.onclose?.(1006);
    expect(timers.heartbeats.every((t) => t.cancelled)).toBe(true);
    timers.retries.at(-1)?.run();
    sockets.at(-1)?.receive(READY);
    connection.stop();
    expect(timers.heartbeats.every((t) => t.cancelled)).toBe(true);
  });
```
Run: `pnpm --filter @alicia/desktop test chat-connection` → FAIL.

- [ ] **Step 2: Implémenter**

Dans `apps/desktop/src/renderer/src/lib/chat-connection.ts` :
- constantes sous `READY_TIMEOUT_CLOSE` :
```ts
/** The brain sends a heartbeat every 30 s: 75 s of silence means the link is dead. */
const HEARTBEAT_TIMEOUT_MS = 75_000;
const HEARTBEAT_TIMEOUT_CLOSE = 4001;
```
- champ : `#cancelHeartbeat: (() => void) | null = null;`
- dans `stop()`, après `this.#clearReadyTimeout();` : `this.#clearHeartbeat();`
- dans `#open()`, le gestionnaire de messages passe le socket :
```ts
    socket.onmessage = (data) => {
      if (this.#socket !== socket) return;
      this.#receive(socket, data);
    };
```
- nouvelles méthodes, après `#clearReadyTimeout` :
```ts
  #clearHeartbeat(): void {
    this.#cancelHeartbeat?.();
    this.#cancelHeartbeat = null;
  }

  /** (Re)starts the watchdog: without any message for 75 s, the socket is given up and a reconnect scheduled. */
  #watch(socket: SocketLike): void {
    this.#clearHeartbeat();
    this.#cancelHeartbeat = this.#options.schedule(() => {
      this.#cancelHeartbeat = null;
      if (this.#socket !== socket) return;
      // The system may take minutes to report a dead link: give the socket up now. Its late close event,
      // if any, is ignored since it is no longer the current socket.
      socket.close(HEARTBEAT_TIMEOUT_CLOSE);
      this.#closed(HEARTBEAT_TIMEOUT_CLOSE);
    }, HEARTBEAT_TIMEOUT_MS);
  }
```
- `#receive` devient :
```ts
  #receive(socket: SocketLike, data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerEvent.safeParse(json);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === "ready") {
      this.#clearReadyTimeout();
      this.#ready = true;
      this.#attempt = 0;
      this.#options.onStatus("ready");
    }
    if (this.#ready) this.#watch(socket);
    // Liveness only: nothing for the consumers.
    if (event.type === "heartbeat") return;
    try {
      this.#options.onEvent(event);
    } catch {
      // A faulty consumer must not break the connection; log the type only.
      console.error(`chat event handler failed (${event.type})`);
    }
  }
```
- dans `#closed`, après `this.#clearReadyTimeout();` : `this.#clearHeartbeat();`

Dans `apps/desktop/src/renderer/src/lib/chat-store.svelte.ts`, dans `handle`, à côté de `case "ready":` :
```ts
      case "ready":
      case "heartbeat":
        return;
```

- [ ] **Step 3: Lancer les tests**

Run: `pnpm --filter @alicia/desktop test` → PASS (les tests existants de reconnexion restent verts : le filtre `retries` exclut les chiens de garde).

- [ ] **Step 4: Vérifier (e2e compris) et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e` → vert (« the app shows when the brain is away and recovers when it is back » couvre la reconnexion réelle).
```bash
git add apps/desktop/src/renderer/src/lib/chat-connection.ts apps/desktop/src/renderer/src/lib/chat-store.svelte.ts apps/desktop/test/chat-connection.test.ts
git commit -m "feat(desktop): reconnect when the brain goes silent" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Contre-pression sur le WebSocket

**Files:**
- Create: `apps/brain/src/server/backpressure.ts`
- Modify: `apps/brain/src/server/ws.ts` (boucle du tour), `apps/brain/src/server/server.ts` (`ServerDependencies`)
- Test: `apps/brain/test/backpressure.test.ts` (nouveau), `apps/brain/test/server-ws.test.ts`

- [ ] **Step 1: Tests unitaires**

Créer `apps/brain/test/backpressure.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { type DrainOptions, waitForDrain } from "../src/server/backpressure.ts";

function fakeSocket(bufferedAmount: number) {
  return { bufferedAmount, readyState: 1, OPEN: 1 };
}

describe("waitForDrain", () => {
  test("under the high-water mark: true at once, without waiting", async () => {
    let waits = 0;
    const options: DrainOptions = { highWaterBytes: 100, timeoutMs: 1_000, pollMs: 10, wait: () => { waits++; return Promise.resolve(); } };
    expect(await waitForDrain(fakeSocket(100), options)).toBe(true);
    expect(waits).toBe(0);
  });

  test("waits while the buffer drains, then true", async () => {
    const socket = fakeSocket(300);
    const options: DrainOptions = {
      highWaterBytes: 100, timeoutMs: 1_000, pollMs: 10,
      wait: () => { socket.bufferedAmount -= 100; return Promise.resolve(); },
    };
    expect(await waitForDrain(socket, options)).toBe(true);
    expect(socket.bufferedAmount).toBe(100);
  });

  test("never drains: false after the timeout", async () => {
    let waited = 0;
    const options: DrainOptions = { highWaterBytes: 100, timeoutMs: 50, pollMs: 10, wait: (ms) => { waited += ms; return Promise.resolve(); } };
    expect(await waitForDrain(fakeSocket(1_000), options)).toBe(false);
    expect(waited).toBe(50);
  });

  test("socket closed while waiting: false", async () => {
    const socket = fakeSocket(1_000);
    const options: DrainOptions = { highWaterBytes: 100, timeoutMs: 1_000, pollMs: 10, wait: () => { socket.readyState = 3; return Promise.resolve(); } };
    expect(await waitForDrain(socket, options)).toBe(false);
  });
});
```
Run: `pnpm --filter @alicia/brain test backpressure` → FAIL (module introuvable).

- [ ] **Step 2: Implémenter**

Créer `apps/brain/src/server/backpressure.ts` :
```ts
import { setTimeout as sleep } from "node:timers/promises";

/** What waitForDrain needs from a WebSocket. */
export interface BufferedSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  readonly OPEN: number;
}

export interface DrainOptions {
  /** Above this many queued bytes, the sender waits. */
  highWaterBytes: number;
  /** Gives up after waiting this long. */
  timeoutMs: number;
  /** Polling period while waiting. */
  pollMs: number;
  /** Injected by tests. */
  wait: (ms: number) => Promise<void>;
}

/** 256 KiB is hundreds of text deltas: only an app that stopped reading gets there. */
export const DEFAULT_DRAIN: DrainOptions = {
  highWaterBytes: 262_144,
  timeoutMs: 30_000,
  pollMs: 50,
  wait: (ms) => sleep(ms),
};

/**
 * Waits until the socket's send buffer is back under the high-water mark (immediately in the usual case).
 * False if the socket is no longer open or did not drain in time: the caller stops sending.
 */
export async function waitForDrain(socket: BufferedSocket, options: DrainOptions): Promise<boolean> {
  let waited = 0;
  while (socket.bufferedAmount > options.highWaterBytes) {
    if (socket.readyState !== socket.OPEN || waited >= options.timeoutMs) return false;
    await options.wait(options.pollMs);
    waited += options.pollMs;
  }
  return socket.readyState === socket.OPEN;
}
```
Run: `pnpm --filter @alicia/brain test backpressure` → PASS.

- [ ] **Step 3: Test d'intégration**

Dans `apps/brain/test/server-ws.test.ts`, importer `type DrainOptions` de `../src/server/backpressure.ts`, ajouter `drain?: DrainOptions` à `StartOptions` (passé à `createServer` comme les autres options), puis :
```ts
  test("an app that does not drain its buffer: the turn stops and the connection closes with 1013", async () => {
    // A negative high-water mark makes every send look congested; a zero timeout gives up at once.
    const { url, token } = await start({
      drain: { highWaterBytes: -1, timeoutMs: 0, pollMs: 1, wait: () => Promise.resolve() },
    });
    const c = connect(url);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "authenticate", token }));
    await c.waitFor((e) => e.type === "ready");
    c.ws.send(JSON.stringify({ type: "send", requestId: REQUEST_ID, text: "Salut" }));
    expect(await c.closed).toBe(1013);
    expect(c.received.some((e) => e.type === "done")).toBe(false);
  });
```
Run: `pnpm --filter @alicia/brain test server-ws` → FAIL (le tour va jusqu'au `done`).

- [ ] **Step 4: Brancher la boucle du tour**

Dans `apps/brain/src/server/server.ts`, importer `import type { DrainOptions } from "./backpressure.ts";` et ajouter à `ServerDependencies` :
```ts
  /** WebSocket backpressure settings (default DEFAULT_DRAIN; adjusted by tests). */
  drain?: DrainOptions;
```
Dans `apps/brain/src/server/ws.ts`, importer `import { DEFAULT_DRAIN, waitForDrain } from "./backpressure.ts";`, ajouter `const CLOSE_TRY_AGAIN_LATER = 1013;` sous `CLOSE_INTERNAL_ERROR`, et remplacer la boucle `for await` du tour par :
```ts
        for await (const e of handleSend(deps.chat, author, message, turn.signal)) {
          // New conversation: locked as soon as its id exists, before another device can see it.
          if (e.type === "conversation" && locked === undefined && locks.acquire(author.id, e.conversationId)) {
            locked = e.conversationId;
          }
          send(e);
          // Backpressure: reading the engine pauses while the app catches up; an app that stays behind
          // (or is gone) ends the turn instead of growing the buffer without limit. It reconnects and resyncs.
          if (!(await waitForDrain(socket, deps.drain ?? DEFAULT_DRAIN))) {
            turn.abort();
            if (socket.readyState === socket.OPEN) socket.close(CLOSE_TRY_AGAIN_LATER, "client too slow");
            break;
          }
        }
```
(Sortir de la boucle referme le générateur : si le moteur avait déjà démarré, `handleSend` enregistre le texte partiel et journalise le tour « annulé » ; si l'arrêt survient dès l'événement `conversation`, rien d'autre n'est écrit.)

- [ ] **Step 5: Lancer les tests**

Run: `pnpm --filter @alicia/brain test` → PASS (dont « closing the connection mid-turn cancels the turn »).

- [ ] **Step 6: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert.
```bash
git add apps/brain/src/server/backpressure.ts apps/brain/src/server/ws.ts apps/brain/src/server/server.ts apps/brain/test/backpressure.test.ts apps/brain/test/server-ws.test.ts
git commit -m "feat(brain): WebSocket backpressure" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Sauvegarde SQLite et rotation des copies

**Files:**
- Create: `apps/brain/src/db/backup.ts`
- Test: `apps/brain/test/backup.test.ts` (nouveau)

- [ ] **Step 1: Écrire les tests**

Créer `apps/brain/test/backup.test.ts` :
```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { backupDatabase, backupFileName, listBackups, pruneBackups } from "../src/db/backup.ts";
import { type Db, openDb } from "../src/db/open.ts";
import { syncPeople } from "../src/identity/people.ts";
import { ELODIE, KEVIN } from "./helpers.ts";

let dir: string | undefined;
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = undefined;
});

function liveDb(): { db: Db; backups: string } {
  dir = mkdtempSync(join(tmpdir(), "alicia-backup-"));
  const db = openDb(join(dir, "alicia.db"));
  opened.push(db);
  return { db, backups: join(dir, "backups") };
}

function peopleIn(path: string): unknown[] {
  const copy = new Database(path, { readonly: true });
  try {
    return copy.prepare("SELECT id FROM people ORDER BY id").pluck().all();
  } finally {
    copy.close();
  }
}

describe("backupDatabase", () => {
  test("copies the live database under the day's name", async () => {
    const { db, backups } = liveDb();
    syncPeople(db, [KEVIN, ELODIE]);
    const path = await backupDatabase(db.$client, backups, "2026-10-04");
    expect(path).toBe(join(backups, "alicia-2026-10-04.db"));
    expect(readdirSync(backups)).toEqual(["alicia-2026-10-04.db"]);
    expect(peopleIn(path)).toEqual(["elodie", "kevin"]);
  });

  test("a second backup the same day replaces the first; leftovers of an interrupted one are cleaned", async () => {
    const { db, backups } = liveDb();
    mkdirSync(backups);
    writeFileSync(join(backups, "alicia-2026-10-03.db.partial"), "junk");
    syncPeople(db, [KEVIN]);
    await backupDatabase(db.$client, backups, "2026-10-04");
    syncPeople(db, [KEVIN, ELODIE]);
    const path = await backupDatabase(db.$client, backups, "2026-10-04");
    expect(readdirSync(backups)).toEqual(["alicia-2026-10-04.db"]);
    expect(peopleIn(path)).toEqual(["elodie", "kevin"]);
  });
});

describe("pruneBackups", () => {
  test("keeps the 14 most recent backups and touches nothing else", () => {
    dir = mkdtempSync(join(tmpdir(), "alicia-backup-"));
    for (let day = 1; day <= 16; day++) {
      writeFileSync(join(dir, backupFileName(`2026-09-${String(day).padStart(2, "0")}`)), "");
    }
    writeFileSync(join(dir, "notes.txt"), "");
    expect(pruneBackups(dir)).toEqual(["alicia-2026-09-01.db", "alicia-2026-09-02.db"]);
    expect(listBackups(dir)).toHaveLength(14);
    expect(listBackups(dir)[0]).toBe("alicia-2026-09-03.db");
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  test("no backup directory yet: nothing to list or prune", () => {
    expect(listBackups(join(tmpdir(), "alicia-no-such-dir"))).toEqual([]);
    expect(pruneBackups(join(tmpdir(), "alicia-no-such-dir"))).toEqual([]);
  });
});
```
Run: `pnpm --filter @alicia/brain test backup` → FAIL (module introuvable).

- [ ] **Step 2: Implémenter**

Créer `apps/brain/src/db/backup.ts` :
```ts
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./open.ts";

/** Spec, « Déploiement » : 14 backups kept. */
export const BACKUP_KEEP = 14;

const BACKUP_FILE = /^alicia-\d{4}-\d{2}-\d{2}\.db$/;
const PARTIAL_SUFFIX = ".partial";

/** `day` is a local date, YYYY-MM-DD: names sort in chronological order. */
export function backupFileName(day: string): string {
  return `alicia-${day}.db`;
}

/**
 * Copies the live database with SQLite's online backup API (consistent while the brain keeps writing,
 * copied page by page without blocking the event loop for long), into a temporary file renamed at the
 * end: a backup file is either complete or absent. Replaces the same day's backup. Returns its path.
 */
export async function backupDatabase(sqlite: Db["$client"], dir: string, day: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.endsWith(PARTIAL_SUFFIX)) rmSync(join(dir, name), { force: true });
  }
  const target = join(dir, backupFileName(day));
  const partial = `${target}${PARTIAL_SUFFIX}`;
  await sqlite.backup(partial);
  renameSync(partial, target);
  return target;
}

/** Backup file names, oldest first. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort((a, b) => a.localeCompare(b));
}

/** Keeps the most recent backups (not "the last 14 days": a brain switched off for weeks keeps its copies). */
export function pruneBackups(dir: string, keep: number = BACKUP_KEEP): string[] {
  const all = listBackups(dir);
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}
```

- [ ] **Step 3: Lancer les tests**

Run: `pnpm --filter @alicia/brain test backup` → PASS.

- [ ] **Step 4: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert.
```bash
git add apps/brain/src/db/backup.ts apps/brain/test/backup.test.ts
git commit -m "feat(brain): SQLite online backup with the 14 most recent kept" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Maintenance nocturne branchée au cerveau

**Files:**
- Create: `apps/brain/src/maintenance.ts`
- Modify: `apps/brain/src/application.ts`, `apps/brain/src/cli.ts` (`start`)
- Test: `apps/brain/test/maintenance.test.ts` (nouveau), `apps/brain/test/application.test.ts`

- [ ] **Step 1: Écrire les tests**

Créer `apps/brain/test/maintenance.test.ts` :
```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConversationRepository } from "../src/conversations/repository.ts";
import { listBackups } from "../src/db/backup.ts";
import { type Db, openDb } from "../src/db/open.ts";
import { turnLog } from "../src/db/schema.ts";
import { syncPeople } from "../src/identity/people.ts";
import { localTime, Maintenance } from "../src/maintenance.ts";
import { createTestClock, KEVIN } from "./helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let dir: string | undefined;
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = undefined;
});

function setup(options: { blockBackups?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), "alicia-maintenance-"));
  const db = openDb(join(dir, "alicia.db"));
  opened.push(db);
  syncPeople(db, [KEVIN]);
  const backupDir = join(dir, "backups");
  // A file where the directory should be: every backup fails.
  if (options.blockBackups === true) writeFileSync(backupDir, "");
  const time = createTestClock(Date.UTC(2026, 9, 4, 0, 30)); // 02:30 in Paris (summer time)
  const repository = new ConversationRepository(db, time.clock);
  const intervals: { ms: number; run: () => void; stopped: boolean }[] = [];
  const logs: string[] = [];
  const maintenance = new Maintenance({
    sqlite: db.$client,
    repository,
    backupDir,
    timezone: "Europe/Paris",
    clock: time.clock,
    every: (run, ms) => {
      const interval = { ms, run, stopped: false };
      intervals.push(interval);
      return () => {
        interval.stopped = true;
      };
    },
    log: (message) => {
      logs.push(message);
    },
  });
  return { db, time, repository, maintenance, intervals, logs, backups: () => listBackups(backupDir) };
}

describe("localTime", () => {
  test("day and hour in the household's time zone", () => {
    expect(localTime(Date.UTC(2026, 9, 4, 0, 30), "Europe/Paris")).toEqual({ day: "2026-10-04", hour: 2 });
    expect(localTime(Date.UTC(2026, 9, 3, 22, 30), "Europe/Paris")).toEqual({ day: "2026-10-04", hour: 0 });
    expect(localTime(Date.UTC(2027, 0, 3, 2, 30), "Europe/Paris")).toEqual({ day: "2027-01-03", hour: 3 });
  });
});

describe("Maintenance", () => {
  test("once per local day, from 3:00", async () => {
    const { time, maintenance, backups } = setup();
    await maintenance.tick();
    expect(backups()).toEqual([]);
    time.advance(HOUR); // 03:30
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
    time.advance(HOUR); // 04:30: already done today
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
    time.advance(DAY - 2 * HOUR); // next day, 02:30
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
    time.advance(HOUR);
    await maintenance.tick();
    expect(backups()).toEqual(["alicia-2026-10-04.db", "alicia-2026-10-05.db"]);
  });

  test("the nightly job rotates the turn log", async () => {
    const { db, time, repository, maintenance } = setup();
    const c = repository.create("kevin", "Vieille");
    repository.logTurn({
      conversationId: c.id, model: "sonnet", inputTokens: 1, outputTokens: 1, durationMs: 1, tools: [], error: null,
    });
    time.advance(91 * DAY);
    await maintenance.runNow();
    expect(db.select().from(turnLog).all()).toEqual([]);
  });

  test("start catches up at once, then ticks every hour; stop ends it", async () => {
    const { time, maintenance, intervals, backups } = setup();
    time.advance(HOUR); // 03:30: the brain was off at 3:00
    await maintenance.start();
    expect(backups()).toEqual(["alicia-2026-10-04.db"]);
    expect(intervals.map((i) => i.ms)).toEqual([HOUR]);
    await maintenance.stop();
    expect(intervals[0]?.stopped).toBe(true);
  });

  test("concurrent ticks share a single run", async () => {
    const { time, maintenance } = setup();
    time.advance(HOUR);
    const first = maintenance.tick();
    expect(maintenance.tick()).toBe(first);
    await first;
  });

  test("a failure is logged, never thrown", async () => {
    const { time, maintenance, logs } = setup({ blockBackups: true });
    time.advance(HOUR);
    await maintenance.tick();
    expect(logs.some((m) => m.startsWith("Maintenance nocturne échouée"))).toBe(true);
  });
});
```
Run: `pnpm --filter @alicia/brain test maintenance` → FAIL (module introuvable).

- [ ] **Step 2: Implémenter le planificateur**

Créer `apps/brain/src/maintenance.ts` :
```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.ts";
import type { ConversationRepository } from "./conversations/repository.ts";
import { backupDatabase, backupFileName, pruneBackups } from "./db/backup.ts";
import type { Db } from "./db/open.ts";

const HOUR_MS = 3_600_000;
/** Local hour from which the nightly job may run. */
export const NIGHTLY_HOUR = 3;

export interface MaintenanceOptions {
  sqlite: Db["$client"];
  repository: ConversationRepository;
  /** `<dataDir>/backups`. */
  backupDir: string;
  /** The household's time zone (config `timezone`): "nightly" and backup names follow it. */
  timezone: string;
  clock: Clock;
  /** Repeats `run` every `ms`; returns a stop function (default: an unref'd setInterval). */
  every?: (run: () => void, ms: number) => () => void;
  log?: (message: string) => void;
}

const everyInterval = (run: () => void, ms: number): (() => void) => {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};

/** Local calendar day (YYYY-MM-DD) and hour (0-23) of an instant in a time zone. */
export function localTime(ms: number, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}

/**
 * The brain's nightly job: turn log rotation (90 days), then a backup of the database (14 kept).
 * Checked every hour; runs once per local day, at the first tick from 3:00. Today's backup file is the
 * proof it ran, so a restart does not run it twice, and a brain that was off at 3:00 catches up.
 */
export class Maintenance {
  readonly #sqlite: Db["$client"];
  readonly #repository: ConversationRepository;
  readonly #backupDir: string;
  readonly #timezone: string;
  readonly #clock: Clock;
  readonly #every: (run: () => void, ms: number) => () => void;
  readonly #log: (message: string) => void;
  #stopTimer: (() => void) | undefined;
  #running: Promise<void> | undefined;

  constructor(options: MaintenanceOptions) {
    this.#sqlite = options.sqlite;
    this.#repository = options.repository;
    this.#backupDir = options.backupDir;
    this.#timezone = options.timezone;
    this.#clock = options.clock;
    this.#every = options.every ?? everyInterval;
    this.#log = options.log ?? ((message) => {
      console.log(message);
    });
  }

  /** Starts the hourly check; resolves once the catch-up tick is done. */
  start(): Promise<void> {
    this.#stopTimer ??= this.#every(() => {
      void this.tick();
    }, HOUR_MS);
    return this.tick();
  }

  /** Stops the hourly check and waits for a running job (the database must not close under a backup). */
  async stop(): Promise<void> {
    this.#stopTimer?.();
    this.#stopTimer = undefined;
    await this.#running;
  }

  /** Runs the nightly job if it is due. Never rejects; concurrent calls share the same run. */
  tick(): Promise<void> {
    this.#running ??= this.#tickOnce().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Rotation, backup of the day (replacing today's if any) and pruning, now. Returns the backup path. */
  async runNow(): Promise<string> {
    const purged = this.#repository.purgeTurnLog();
    const { day } = localTime(this.#clock(), this.#timezone);
    const path = await backupDatabase(this.#sqlite, this.#backupDir, day);
    const removed = pruneBackups(this.#backupDir);
    this.#log(
      `Sauvegarde écrite : ${path} (journal : ${purged} entrées de plus de 90 jours supprimées ; ${removed.length} anciennes sauvegardes supprimées).`,
    );
    return path;
  }

  async #tickOnce(): Promise<void> {
    try {
      const { day, hour } = localTime(this.#clock(), this.#timezone);
      if (hour < NIGHTLY_HOUR || existsSync(join(this.#backupDir, backupFileName(day)))) return;
      await this.runNow();
    } catch (error) {
      this.#log(`Maintenance nocturne échouée : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
```
Run: `pnpm --filter @alicia/brain test maintenance` → PASS.

- [ ] **Step 3: Test d'assemblage**

Dans `apps/brain/test/application.test.ts`, ajouter `basename`, `dirname` à l'import de `node:path` et `readdirSync` à celui de `node:fs`, puis :
```ts
test("the nightly job writes its backup into <dataDir>/backups", async () => {
  dir = mkdtempSync(join(tmpdir(), "alicia-"));
  const config = parseConfig(`
dataDir: ${JSON.stringify(dir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const app = await buildApplication(config, new FakeEngine(() => []), { embedder: new FakeEmbedder() });
  const path = await app.maintenance.runNow();
  await app.close();
  expect(dirname(path)).toBe(join(dir, "backups"));
  expect(readdirSync(join(dir, "backups"))).toEqual([basename(path)]);
  const copy = new Database(path, { readonly: true });
  const ids = copy.prepare("SELECT id FROM people").pluck().all();
  copy.close();
  expect(ids).toEqual(["kevin"]);
});
```
Run: `pnpm --filter @alicia/brain test application` → FAIL (`maintenance` absent).

- [ ] **Step 4: Brancher l'application**

Dans `apps/brain/src/application.ts` : importer `import { Maintenance } from "./maintenance.ts";`, ajouter à l'interface `Application` :
```ts
  /** Nightly job (backup, journal rotation): started by `start` only, never by the maintenance commands. */
  maintenance: Maintenance;
```
dans `buildApplication`, après la création de `pairing` :
```ts
    const maintenance = new Maintenance({
      sqlite: db.$client,
      repository,
      backupDir: join(config.dataDir, "backups"),
      timezone: config.timezone,
      clock: systemClock,
    });
```
et renvoyer :
```ts
    return {
      server,
      memory,
      pairing,
      maintenance,
      close: async () => {
        await maintenance.stop();
        await server.close();
        db.$client.close();
      },
    };
```
Dans `apps/brain/src/cli.ts`, fonction `start`, juste après la ligne `console.log(\`Alicia écoute sur …\`)` :
```ts
  // Nightly job (backup, journal rotation); catches up at once if the brain was off at 3:00.
  void app.maintenance.start();
```

- [ ] **Step 5: Lancer les tests**

Run: `pnpm --filter @alicia/brain test` → PASS.

- [ ] **Step 6: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert (les e2e de l'app appellent `buildApplication` sans démarrer la maintenance).
```bash
git add apps/brain/src/maintenance.ts apps/brain/src/application.ts apps/brain/src/cli.ts apps/brain/test/maintenance.test.ts apps/brain/test/application.test.ts
git commit -m "feat(brain): nightly maintenance (backup, journal rotation)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Commande `backup` et documentation

**Files:**
- Modify: `apps/brain/src/cli.ts`, `README.md`

- [ ] **Step 1: La commande**

Dans `apps/brain/src/cli.ts`, ajouter dans `HELP`, après la ligne `revoke` :
```
  backup                         sauvegarde la base maintenant (garde les 14 plus récentes)
```
ajouter, après `revoke` :
```ts
async function backup(): Promise<void> {
  const config = loadConfig(configPath());
  const app = await buildApplication(config, UNUSED_ENGINE);
  try {
    await app.maintenance.runNow();
  } finally {
    await app.close();
  }
}
```
(`runNow` affiche lui-même le chemin écrit), et dans le `switch (command)` de `main` :
```ts
    case "backup":
      return backup();
```
Adapter le commentaire de `UNUSED_ENGINE` : « `pair`, `devices`, `revoke` and `backup` do not need the engine: it must never be called. »

- [ ] **Step 2: Vérification manuelle sur une config temporaire (jamais la vraie)**

Dans PowerShell, depuis la racine du dépôt :
```powershell
$tmp = Join-Path $env:TEMP "alicia-backup-check"; New-Item -ItemType Directory -Force $tmp | Out-Null
$data = (Join-Path $tmp "data") -replace '\\', '/'
@"
dataDir: "$data"
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
"@ | Set-Content -Encoding utf8 (Join-Path $tmp "alicia.config.yaml")
$env:ALICIA_CONFIG = Join-Path $tmp "alicia.config.yaml"; pnpm --filter @alicia/brain alicia backup; Remove-Item Env:ALICIA_CONFIG
Get-ChildItem (Join-Path $tmp "data/backups")
Remove-Item -Recurse -Force $tmp
```
Expected: `Sauvegarde écrite : …/data/backups/alicia-AAAA-MM-JJ.db (…)` puis un seul fichier `alicia-AAAA-MM-JJ.db`. Aucun port ouvert, aucun appel au moteur.

- [ ] **Step 3: README**

Dans `README.md` (en conservant ses fins de ligne CRLF) :
- dans le bloc « Commandes », après la ligne `revoke` :
```
pnpm --filter @alicia/brain alicia backup              # sauvegarde la base maintenant
```
- ajouter, juste avant `## Vérification réelle (manuelle, consomme un peu de quota)` :
```markdown
## Sauvegardes, journal et réseau

- **Sauvegarde nocturne** : le cerveau démarré (`start`) copie sa base chaque nuit, à partir de 3 h (heure du
  `timezone` de la config), avec l'API de sauvegarde de SQLite, dans `<dataDir>/backups/alicia-AAAA-MM-JJ.db`.
  Il garde les **14 plus récentes**. S'il était éteint à 3 h, il rattrape au démarrage. `alicia backup` en fait
  une tout de suite.
- **Restaurer** : arrêter le cerveau, remplacer `<dataDir>/alicia.db` par la copie choisie, supprimer
  `alicia.db-wal` et `alicia.db-shm` s'ils existent, relancer.
- **Journal** : le détail des tours (modèle, tokens, outils, durée) est effacé au-delà de 90 jours, au même moment.
- **Appairage** : 5 codes faux en 15 minutes depuis une même adresse bloquent cette adresse (en plus de la limite
  globale de 5 par minute).
- **Origines web** : seule l'app de bureau peut appeler le cerveau depuis une page web ; `allowedOrigins` (config)
  ajoute des origines exactes, pour la future PWA. Une autre origine reçoit 403, en HTTP comme en WebSocket.
- **Connexions** : le cerveau sonde chaque connexion toutes les 30 s et coupe celles qui ne répondent plus ; l'app
  se reconnecte d'elle-même après 75 s de silence.
```

- [ ] **Step 4: Vérifier et commiter**

Run: `pnpm test && pnpm typecheck && pnpm lint` → vert.
```bash
git add apps/brain/src/cli.ts README.md
git commit -m "feat(brain): backup command; document backups, journal and network hardening" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Vérification finale

- [ ] **Step 1: Tout le dépôt**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout vert.

- [ ] **Step 2: Contrôles ciblés**

- `rg -n "send\(\{ error" apps/brain/src` → aucun résultat (toutes les erreurs HTTP passent par `http-errors.ts`).
- `rg -n "unreadable_session" apps/brain/src apps/desktop/src packages` → seulement `engine.ts`, `sdk-engine.ts`, `chat-service.ts` (jamais dans le protocole ni l'app).
- `git status --short` → rien d'inattendu ; en particulier rien sous `apps/brain/data/`, ni `.env`, ni `alicia.config.yaml`.

- [ ] **Step 3: Rapport**

Lister les commits de la branche (`git log --oneline 2ebb730..HEAD`) et signaler tout écart avec ce plan (libellé de plan SQLite différent, `Origin` Electron différent, etc.).

---

## Couverture de la demande et de la spec

| Exigence | Tâche |
|---|---|
| Index : conversations par personne + date, messages par conversation, appareils par jeton (déjà présents, vérifiés) | 1 |
| Index manquants : `turn_log` (conversation, date), `memories.conversation_id` | 1 |
| Journal : rotation au-delà de 90 jours (spec « Journal ») | 2, 13 |
| `done` à 0 token quand le flux finit sans résultat → erreur explicite | 3 |
| Session illisible : reset seulement sur vraie session illisible ; nouvelle session amorcée par l'historique en base (spec « Erreurs ») | 4 |
| Schéma d'erreur HTTP typé partagé, utilisé par toutes les routes (404 de route compris) | 5 |
| L'app de bureau lit ce schéma | 6 |
| Limiteur d'appairage par adresse IP (code à 6 chiffres) | 7 |
| CORS + contrôle d'`Origin` (HTTP et mise à niveau WebSocket), liste d'origines en config, vide par défaut | 8 |
| Battement de cœur WebSocket (ping/pong, connexions mortes coupées) ; l'app se reconnecte | 9, 10 |
| Contre-pression WebSocket (`bufferedAmount`) | 11 |
| Sauvegarde nocturne par l'API de sauvegarde SQLite, 14 conservées, `<dataDir>/backups`, minuterie testable, commande `backup` (spec « Déploiement ») | 12, 13, 14 |
| Cerveau injoignable → reconnexion automatique (spec « Erreurs »), y compris lien mort silencieux | 10 |
