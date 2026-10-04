# Alicia — Plan « Souvenirs » : écran, banc d'essai, suppression de conversations — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dans l'app de bureau, un écran « Souvenirs » (liste + fiche, disposition B) pour voir, ajouter, corriger, épingler, déplacer, oublier et récupérer les souvenirs ; un banc d'essai qui montre ce qu'Alicia retrouverait pour une question et pourquoi ; la suppression d'une conversation depuis le menu.

**Architecture:** Le cerveau gagne trois capacités dans `MemoryStore` (corbeille, récupération, explication d'une recherche), une suppression transactionnelle de conversation, et les routes HTTP correspondantes. Le protocole enrichit `MemorySummary` (provenance, usage, oubli) et ajoute `MemoryTestHit`. Côté app, un client HTTP étendu, un état d'écran `MemoryScreen` en runes Svelte 5 testé sans interface, un routage minimal de vues dans `Shell` (chat ↔ souvenirs), et des composants minces.

**Spec :** `docs/superpowers/specs/2026-10-04-alicia-souvenirs-design.md`

**Tech Stack:** celle du dépôt (TypeScript ~6.0.3 strict, Zod 4, Drizzle/better-sqlite3, Fastify, Electron + electron-vite 6 bêta + Vite 8, Svelte 5, Vitest 5, Playwright `_electron`).

---

## Conventions (à lire avant la tâche 1)

- **Code en anglais**, textes affichés en français. Imports relatifs en `.ts`. Champs privés `#`, pas de propriétés de paramètres, pas d'`enum`.
- Strict maximal, **pas d'`any`, pas d'assertion de type dans `src/`, pas de règle de lint désactivée** ; `svelte-check --fail-on-warnings`.
- TDD : test d'abord, le voir échouer, implémenter, le voir passer. **Commit seulement si `pnpm test && pnpm typecheck && pnpm lint` sont verts** (et l'e2e pour les tâches qui touchent l'app). Commits en anglais terminés par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Jamais `git add -A`.**
- Ne jamais toucher `apps/brain/.env`, `apps/brain/alicia.config.yaml`, `apps/brain/data/`, ni `C:\Sources\alice`. **Le vrai cerveau de Kévin tourne sur le port 8780** : les tests utilisent le port 0.
- Lire le code réel avant d'écrire : les noms ci-dessous correspondent à `main` au 2026-10-04 (`MemoryStore`, `ConversationRepository`, `registerMemoryRoutes`, `ConversationLocks`, `BrainApi`, `ChatStore`, `Shell.svelte`, `Sidebar.svelte`…). En cas d'écart, s'aligner sur le code et le signaler.
- Transitions fluides (via `motion()` de `lib/motion.ts`), jamais de saut sec.

---

### Task 1: Corbeille, récupération et explication dans le magasin

**Files:** Modify `apps/brain/src/memory/store.ts` ; Test `apps/brain/test/memory-store.test.ts`

Nouvelles méthodes de `MemoryStore` :
```ts
/** Forgotten memories still recoverable (forgotten less than 30 days ago), newest first. */
listForgotten(personId: string): Memory[]

/** Brings a forgotten memory back (same reach rules). */
restore(personId: string, id: string): Memory | undefined

export interface SearchExplanation {
  memory: Memory;
  rank: number;          // 1-based, same order as search()
  textMatch: boolean;    // found by the full-text index
  similarity: number;    // cosine with the query (0 when compared vectors are from another model)
}
/** Exactly what search() would return, with the reasons; never counts as a recall. */
explain(personId: string, query: string, limit?: number): Promise<SearchExplanation[]>
```
Règles :
- `listForgotten` : portée commun + la personne, `forgotten_at` non nul et plus récent que 30 jours (`clock() - 30 j`), tri `forgotten_at` décroissant.
- `restore` : condition SQL `id = ? AND scope IN (common, person) AND forgotten_at IS NOT NULL AND forgotten_at >= clock() - 30 j` ; met `forgotten_at = NULL`, `updated_at = now` ; `changes === 1` sinon `undefined`.
- `explain` : **réutiliser la même logique que `search`** (factoriser en une méthode privée `#rank(personId, query)` qui renvoie la liste ordonnée d'ids + les ensembles « trouvé par FTS » et les similarités), pour que l'explication ne puisse jamais diverger de ce qu'Alicia voit. `search` et `explain` partagent `#rank` ; seul `search` fait la comptabilité de rappel (si `recall`).

Tests (à écrire d'abord) :
```ts
describe("trash", () => {
  test("forgotten memories are listed for 30 days, then purged from the list", async () => {
    const { store, time } = setup();
    const result = await remember(store, "kevin", "Rendez-vous chez le dentiste mardi");
    if (result.status !== "created") throw new Error("not created");
    store.forget("kevin", result.memory.id);
    expect(store.listForgotten("kevin").map((m) => m.id)).toEqual([result.memory.id]);
    expect(store.listForgotten("elodie")).toEqual([]);
    time.advance(31 * 24 * 3_600_000);
    expect(store.listForgotten("kevin")).toEqual([]);
  });

  test("restore brings it back; not for someone else; not after 30 days", async () => {
    const { store, time } = setup();
    const a = await remember(store, "kevin", "Kévin boit du thé le matin");
    const b = await remember(store, "kevin", "Kévin court le dimanche");
    if (a.status !== "created" || b.status !== "created") throw new Error("not created");
    store.forget("kevin", a.memory.id);
    store.forget("kevin", b.memory.id);
    expect(store.restore("elodie", a.memory.id)).toBeUndefined();
    expect(store.restore("kevin", a.memory.id)?.forgottenAt).toBeNull();
    expect(await store.search("kevin", "thé")).toHaveLength(1);
    time.advance(31 * 24 * 3_600_000);
    expect(store.restore("kevin", b.memory.id)).toBeUndefined();
  });
});

describe("explain", () => {
  test("same order as search, with reasons, and no recall counted", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Kévin adore les lasagnes");
    await remember(store, "kevin", "Les lasagnes de mamie sont les meilleures");
    const explained = await store.explain("kevin", "lasagnes");
    const searched = await store.search("kevin", "lasagnes", { recall: false });
    expect(explained.map((e) => e.memory.id)).toEqual(searched.map((m) => m.id));
    expect(explained.map((e) => e.rank)).toEqual([1, 2]);
    expect(explained.every((e) => e.textMatch)).toBe(true);
    expect(explained[0]?.similarity).toBeGreaterThan(0);
    expect(explained[0]?.memory.recallCount).toBe(0);
  });

  test("respects cloisonnement", async () => {
    const { store } = setup();
    await remember(store, "kevin", "Surprise pour Élodie");
    expect(await store.explain("elodie", "surprise")).toEqual([]);
  });
});
```
Commit : `feat(brain): memory trash, restore and search explanation`

---

### Task 2: Suppression d'une conversation

**Files:** Modify `apps/brain/src/conversations/repository.ts`, `apps/brain/src/server/server.ts` ; Test `apps/brain/test/repository.test.ts` (nom réel du fichier de tests du dépôt), `apps/brain/test/server-http.test.ts`

- `ConversationRepository.delete(id: string, personId: string): boolean` : dans **une transaction**, vérifier l'appartenance (`get(id, personId)`), supprimer `turn_log` puis `messages` de la conversation, puis la conversation. Les souvenirs liés passent à `conversation_id = NULL` (clé étrangère `ON DELETE SET NULL` déjà en place — le vérifier par un test). Renvoie `false` si la conversation n'est pas à cette personne.
- Route `DELETE /conversations/:id` (Bearer) : 401 sans jeton ; 404 si pas à soi ; **409 `{ error: "busy" }` si un tour est en cours** dans cette conversation (le `ConversationLocks` créé dans `createServer` doit être accessible à la route : le créer avant l'enregistrement des routes et l'utiliser via `acquire`/`release` — prendre le verrou, supprimer, relâcher — pour qu'aucun tour ne démarre pendant la suppression) ; 204 sinon.

Tests :
```ts
test("delete removes the conversation, its messages and log; memories stay, unlinked", async () => { /* repository + MemoryStore sur la même base de test : créer conversation, message, logTurn, souvenir lié ; delete → get undefined, messages [], souvenir présent avec conversationId null */ });
test("delete refuses someone else's conversation", () => { /* delete(id, "elodie") === false, conversation intacte */ });
test("DELETE /conversations/:id → 204, then 404; 404 for another person; 401 without token", async () => { /* via app.inject */ });
test("DELETE /conversations/:id → 409 while a turn runs", async () => { /* prendre le verrou à la main via une ConversationLocks exposée aux tests (ou un tour WebSocket bloqué comme dans server-ws.test.ts), puis inject DELETE → 409 { error: "busy" } */ });
```
Commit : `feat(brain): delete a conversation (owner only, not while Alicia answers), memories kept`

---

### Task 3: Protocole et routes de la mémoire

**Files:** Modify `packages/protocol/src/memory.ts`, `apps/brain/src/server/memory-routes.ts` ; Test `packages/protocol/test/protocol.test.ts`, `apps/brain/test/server-memories.test.ts`

Protocole :
```ts
export const MemorySource = z.enum(["conversation", "manual", "import"]);

export const MemorySummary = z.object({
  id: z.uuid(),
  scope: MemoryScope,
  kind: MemoryKind,
  text: z.string(),
  pinned: z.boolean(),
  source: MemorySource,
  conversationId: z.uuid().nullable(),
  /** Title of the source conversation when it still exists and belongs to the caller. */
  conversationTitle: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  recallCount: count,
  lastRecalledAt: z.iso.datetime().nullable(),
  forgottenAt: z.iso.datetime().nullable(),
});

export const MemoryTestHit = z.object({
  memory: MemorySummary,
  rank: z.number().int().positive(),
  textMatch: z.boolean(),
  similarity: z.number().min(-1).max(1),
});
export type MemoryTestHit = z.infer<typeof MemoryTestHit>;
```
Routes (dans `registerMemoryRoutes`, qui reçoit aussi le `ConversationRepository` pour les titres) :
- `GET /memories?forgotten=true` → `listForgotten` (les autres filtres `scope`/`kind` s'appliquent aussi) ; `forgotten` et `q` ensemble → 400.
- `POST /memories/:id/restore` → 200 résumé / 404 `{ error: "not_found" }`.
- `GET /memories/test?q=…` (q obligatoire, 1–300) → `MemoryTestHit[]` via `explain` (limite 8, comme Alicia).
- `summary()` remplit les nouveaux champs ; `conversationTitle` = `repository.get(conversationId, person.id)?.title ?? null` (jamais le titre d'une conversation d'une autre personne).
- Enregistrer `/memories/test` **avant** `/memories/:id` si Fastify l'exige (routes statiques prioritaires en général ; vérifier).

Tests : nouveaux champs présents et typés (`MemorySummary.parse` sur chaque réponse) ; titre de conversation présent pour un souvenir retenu en conversation par Kévin, `null` pour un souvenir commun issu d'une conversation d'Élodie vu par Kévin ; corbeille, récupération, 404 pour un autre ; banc d'essai : ordre, raisons, `recallCount` inchangé, 400 sans `q`.

Commit : `feat: memory provenance, trash, restore and test bench over HTTP`

---

### Task 4: Client HTTP de l'app

**Files:** Modify `apps/desktop/src/renderer/src/lib/brain-client.ts` ; Test `apps/desktop/test/brain-client.test.ts`

Ajouter à `BrainApi` (même style : `fetch` non lié, délai de 15 s, 401 → `UnauthorizedError`, réponses validées par Zod) :
```ts
listMemories(filter: { scope?: MemoryScope; kind?: MemoryKind; q?: string; forgotten?: boolean }): Promise<MemorySummary[]>
createMemory(input: MemoryCreate): Promise<MemoryWriteResult>
updateMemory(id: string, patch: MemoryPatch): Promise<MemoryWriteResult>
forgetMemory(id: string): Promise<boolean>          // false = 404
restoreMemory(id: string): Promise<MemorySummary | null>
testMemory(q: string): Promise<MemoryTestHit[]>
deleteConversation(id: string): Promise<"deleted" | "not_found" | "busy">

export type MemoryWriteResult =
  | { ok: true; memory: MemorySummary }
  | { ok: false; reason: "duplicate" | "secret" | "empty" | "not_found" | "invalid" };
```
Corps d'erreur du cerveau : 409 `{error:"duplicate"}`, 422 `{error:"refused", reason}`, 404, 400. Tests avec le faux `fetch` existant pour chaque méthode et chaque cas d'erreur, et l'encodage de la query (`q` avec espaces/accents).

Commit : `feat(desktop): brain client for memories and conversation deletion`

---

### Task 5: État de l'écran « Souvenirs »

**Files:** Create `apps/desktop/src/renderer/src/lib/memory-screen.svelte.ts` ; Test `apps/desktop/test/memory-screen.test.ts`

Classe à runes, testée comme `ChatStore` (ports injectés) :
```ts
export type MemoryTab = "all" | "common" | "personal" | "trash";
export type MemorySort = "recent" | "used" | "dormant";

export interface MemoryPorts {
  list(filter: { scope?: MemoryScope; forgotten?: boolean }): Promise<MemorySummary[]>;
  create(input: MemoryCreate): Promise<MemoryWriteResult>;
  update(id: string, patch: MemoryPatch): Promise<MemoryWriteResult>;
  forget(id: string): Promise<boolean>;
  restore(id: string): Promise<MemorySummary | null>;
  test(q: string): Promise<MemoryTestHit[]>;
  now(): number;
}

export class MemoryScreen {
  tab = $state<MemoryTab>("all");
  kinds = $state<MemoryKind[]>([]);          // empty = all kinds
  query = $state("");
  sort = $state<MemorySort>("recent");
  items = $state<MemorySummary[]>([]);
  loading = $state(false);
  selectedId = $state<string | null>(null);
  draft = $state<{ text: string; scope: MemoryScope; kind: MemoryKind; pinned: boolean } | null>(null);
  creating = $state(false);
  error = $state<string | null>(null);
  bench = $state<{ query: string; hits: MemoryTestHit[] } | null>(null);
  // derived: visible (filter kinds + query words + sort), selected, dirty, isDormant(m)
  load(): Promise<void>; setTab(tab): Promise<void>; select(id): void; startCreate(): void;
  save(): Promise<void>; forget(): Promise<void>; restore(id): Promise<void>; runBench(): Promise<void>; closeBench(): void;
}
```
Règles :
- `load` : `trash` → `list({ forgotten: true })` ; `common`/`personal` → `list({ scope })` ; `all` → `list({})`. Un jeton de chargement ignore les réponses obsolètes (même patron que `ChatStore.open`).
- `visible` (dérivé) : filtre par `kinds`, puis par `query` (tous les mots de la requête, sans accents ni casse, présents dans le texte), puis tri : `recent` = `updatedAt` desc ; `used` = `recallCount` desc puis `lastRecalledAt` desc ; `dormant` = d'abord les « qui dorment » (`recallCount === 0` ou `lastRecalledAt` plus vieux que 60 jours selon `now()`), les plus anciens d'abord.
- `isDormant(m)` : même définition (sert à l'atténuation des cartes).
- `select` copie le souvenir dans `draft` ; `dirty` compare `draft` au souvenir ; `save` envoie un `MemoryPatch` minimal (seulement les champs changés) ; `startCreate` ouvre un `draft` vide (`personal`, `fact`, non épinglé) et `save` appelle `create`.
- Messages d'erreur français : `duplicate` « Alicia sait déjà ça. », `secret` « Alicia ne retient ni mots de passe ni codes. », `empty` « Le souvenir est vide. », `not_found` « Ce souvenir n'existe plus (supprimé ailleurs ?). », `invalid` « Vérifie le texte (1 000 caractères au plus). ».
- `forget` : retire l'élément de la liste, désélectionne. `restore` (onglet corbeille) : retire de la corbeille.
- `runBench` : `test(query)` ; `bench` garde la requête et les résultats ; ne modifie pas la liste.
- `proximity(hit)` (fonction exportée, pure) : `Math.round(100 * clamp((similarity - 0.82) / (1 - 0.82), 0, 1))`.

Tests : chacune de ces règles (chargement par onglet, réponses obsolètes ignorées, filtres et tri, dormance, brouillon/dirty/patch minimal, création, chaque message d'erreur, oubli et récupération, banc d'essai sans toucher la liste, `proximity`).

Commit : `feat(desktop): memory screen state (tabs, filters, sort, draft, trash, bench)`

---

### Task 6: Navigation, menu et suppression de conversation

**Files:** Modify `apps/desktop/src/renderer/src/components/Shell.svelte`, `Sidebar.svelte`, `TitleBar.svelte` (titre), `apps/desktop/src/renderer/src/lib/chat-store.svelte.ts` ; Test `apps/desktop/test/chat-store.test.ts`

- `Shell` : état `view = $state<"chat" | "memories">("chat")` ; la zone principale affiche `ChatView + Composer` ou `MemoryView` (tâche 7) avec un fondu (`motion()`) ; le titre de la barre du haut suit la vue (« Souvenirs » en vue mémoire). Un `MemoryScreen` est créé dans `Shell` avec les ports branchés sur `BrainApi` (`now: () => Date.now()`), et `guarded()` (déconnexion si `UnauthorizedError`).
- `Sidebar` : en tête, deux entrées de navigation **« ✦ Alicia »** et **« 🧠 Souvenirs »** (`aria-current` sur la vue active, `data-testid="nav-chat"` / `"nav-memories"`). Ouvrir une conversation ou « Nouvelle conversation » ramène à la vue chat.
- Chaque conversation de la liste : bouton 🗑 visible au survol et au focus clavier (`data-testid="delete-conversation"`, `aria-label="Supprimer la conversation « … »"`) → confirmation inline dans la ligne : « Supprimer ? » + **Oui** / **Non** (Échap = Non, focus sur Non à l'ouverture), désactivé pendant que `store.busy`.
- `ChatStore.removeConversation(id): Promise<"deleted" | "not_found" | "busy">` (port `deleteConversation`) : sur `deleted`/`not_found`, retire la conversation de la liste et, si c'était l'active, `startNew()` ; sur `busy`, `notice` = « Alicia répond dans cette conversation : réessaie après sa réponse. ». Tests unitaires pour les trois cas.
- Depuis la fiche d'un souvenir, le lien de provenance ouvre la conversation : `Shell` passe à la vue chat et appelle `store.open(conversationId)`.

Commit : `feat(desktop): chat/memories navigation and conversation deletion with inline confirm`

---

### Task 7: L'écran « Souvenirs »

**Files:** Create `apps/desktop/src/renderer/src/components/MemoryView.svelte`, `MemoryList.svelte`, `MemoryDetail.svelte`, `MemoryBench.svelte`

Disposition B (maquette `souvenirs-layout.html`) :
- `MemoryView` : deux colonnes (liste ~48 %, fiche le reste) ; charge `screen.load()` au montage.
- `MemoryList` : onglets Tout / Famille / Moi / Corbeille (`role="tablist"`, `data-testid="memory-tab-<tab>"`) ; ligne recherche (`data-testid="memory-search"`) + bouton « Tester comme question » (`data-testid="memory-bench-run"`, Entrée dans le champ avec Ctrl = tester) + bouton « + » (`data-testid="memory-new"`, masqué dans la corbeille) ; puces de filtre par type (toggle) ; sélecteur de tri (Récents / Plus utilisés / Qui dorment) ; cartes (`data-testid="memory-card"`, `data-dormant`) : texte sur 2 lignes, 📌, portée (Famille/Moi), type ; carte sélectionnée surlignée ; liste vide → message (« Aucun souvenir ici pour l'instant. ») ; dans la corbeille, chaque carte affiche « oublié le … » et un bouton **Récupérer** (`data-testid="memory-restore"`).
- `MemoryBench` : quand `screen.bench` existe, remplace la liste par les résultats (rang, texte, raisons « mots en commun » / « sens proche », barre de proximité `proximity()`), bouton « Fermer le test » ; cliquer un résultat sélectionne le souvenir.
- `MemoryDetail` : sans sélection, aide courte ; sinon textarea (`data-testid="memory-text"`), segments Moi / Famille, sélecteur de type, interrupteur 📌 (même style que « Réfléchir »), provenance (« Retenu par Alicia pendant “<titre>” » cliquable, « Ajouté à la main », « Importé de l'ancienne Alice », « Retenu pendant une conversation supprimée »), usage (« Utilisé N fois, la dernière fois le … » / « Jamais utilisé »), **Enregistrer** (`data-testid="memory-save"`, désactivé si rien n'a changé), **Oublier** (`data-testid="memory-forget"`, confirmation inline), erreur (`role="alert"`).
- Dates en français (`Intl.DateTimeFormat("fr-FR", { dateStyle: "long" })`).
- Couleurs et rayons de `app.css` ; transitions via `motion()` ; aucune barre de défilement de page (seules les colonnes défilent).

Vérification à la main avec un script Playwright jetable contre un cerveau en mémoire (comme pour les tâches précédentes) + deux captures dans le scratchpad (`memories.png`, `memories-bench.png`).

Commit : `feat(desktop): Souvenirs screen (list, detail, trash, test bench)`

---

### Task 8: Bout en bout

**Files:** Modify `apps/desktop/e2e/app.e2e.ts`

Nouveaux scénarios (cerveau en mémoire, `FakeEmbedder`) :
1. Le faux moteur, sur « Retiens que j'adore les lasagnes », appelle `memory_remember` (scénario asynchrone avec `callTool`) → l'écran Souvenirs montre la carte, sa fiche indique « Retenu par Alicia pendant “Retiens que j'adore les lasagnes” » ; correction du texte → Enregistrer → la carte change ; épingler ; Oublier → onglet Corbeille → Récupérer → de retour dans Tout.
2. Banc d'essai : « lasagnes » → le souvenir en tête, raison « mots en commun ».
3. Ajout manuel « Le chat s'appelle Moka » en Famille → visible dans l'onglet Famille.
4. Suppression d'une conversation depuis le menu (Oui) → elle disparaît, l'accueil s'affiche, le souvenir reste dans Souvenirs (provenance « conversation supprimée »).

Commit : `test(desktop): end-to-end Souvenirs screen and conversation deletion`

---

### Task 9: Finitions

- README : section « Souvenirs » (écran, banc d'essai, corbeille 30 jours, suppression de conversations).
- `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e` verts.
- Vérification réelle avec Kévin (son cerveau sur 8780) : critères de réussite de la spec.

Commit : `docs: Souvenirs screen`

---

## Couverture de la spec

| Exigence | Tâche |
|---|---|
| Liste : onglets, recherche, filtres, tri, dormance, ajout | 5, 7 |
| Fiche : édition, portée, type, épingle, provenance, usage, oubli | 3, 5, 7 |
| Corbeille 30 jours + récupération | 1, 3, 5, 7 |
| Banc d'essai (ordre exact, raisons, proximité, sans rappel) | 1, 3, 5, 7 |
| Suppression de conversation (propriétaire, pas pendant une réponse, souvenirs conservés) | 2, 4, 6 |
| Cloisonnement partout | 1, 2, 3 |
| Navigation chat ↔ souvenirs, lien vers la conversation d'origine | 6 |
