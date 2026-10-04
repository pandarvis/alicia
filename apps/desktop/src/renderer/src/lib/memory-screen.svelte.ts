import type {
  MemoryCreate, MemoryKind, MemoryPatch, MemoryScope, MemorySummary, MemoryTestHit,
} from "@alicia/protocol";
import type { MemoryWriteResult } from "./brain-client.ts";

export type MemoryTab = "all" | "common" | "personal" | "trash";
export type MemorySort = "recent" | "used" | "dormant";

export interface MemoryDraft {
  text: string;
  scope: MemoryScope;
  kind: MemoryKind;
  pinned: boolean;
}

/** Everything the screen needs from the outside world (fakes in tests). */
export interface MemoryPorts {
  list(filter: { scope?: MemoryScope; forgotten?: boolean }): Promise<MemorySummary[]>;
  create(input: MemoryCreate): Promise<MemoryWriteResult>;
  update(id: string, patch: MemoryPatch): Promise<MemoryWriteResult>;
  forget(id: string): Promise<boolean>;
  restore(id: string): Promise<MemorySummary | null>;
  test(q: string): Promise<MemoryTestHit[]>;
  now(): number;
}

/** A memory sleeps when it was never recalled, or not for this long. */
export const DORMANT_AFTER_MS = 60 * 24 * 3_600_000;

/** Floor of the brain's semantic search: below it, a memory is not considered close. */
const SIMILARITY_FLOOR = 0.82;

const WRITE_ERRORS: Record<Extract<MemoryWriteResult, { ok: false }>["reason"], string> = {
  duplicate: "Alicia sait déjà ça.",
  secret: "Alicia ne retient ni mots de passe ni codes.",
  empty: "Le souvenir est vide.",
  not_found: "Ce souvenir n'existe plus (supprimé ailleurs ?).",
  invalid: "Vérifie le texte (1 000 caractères au plus).",
};
const UNREACHABLE = "Alicia n'est pas joignable pour l'instant.";

/** Closeness of a test-bench hit, 0–100, normalised between the search floor and a perfect match. */
export function proximity(hit: MemoryTestHit): number {
  const ratio = (hit.similarity - SIMILARITY_FLOOR) / (1 - SIMILARITY_FLOOR);
  return Math.round(100 * Math.min(1, Math.max(0, ratio)));
}

export function isDormant(memory: MemorySummary, now: number): boolean {
  if (memory.recallCount === 0 || memory.lastRecalledAt === null) return true;
  return now - Date.parse(memory.lastRecalledAt) > DORMANT_AFTER_MS;
}

/** Lowercase, accent-free words of a text. */
function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

export interface MemoryView {
  kinds: readonly MemoryKind[];
  query: string;
  sort: MemorySort;
}

/** The list the user sees: kind filter, then every query word (accent- and case-insensitive), then the sort. */
export function visibleMemories(items: readonly MemorySummary[], view: MemoryView, now: number): MemorySummary[] {
  const wanted = words(view.query);
  const filtered = items.filter((memory) => {
    if (view.kinds.length > 0 && !view.kinds.includes(memory.kind)) return false;
    if (wanted.length === 0) return true;
    const present = words(memory.text);
    return wanted.every((word) => present.includes(word));
  });
  return filtered.sort(comparator(view.sort, now));
}

function time(iso: string | null): number {
  return iso === null ? 0 : Date.parse(iso);
}

function comparator(sort: MemorySort, now: number): (a: MemorySummary, b: MemorySummary) => number {
  switch (sort) {
    case "recent":
      return (a, b) => time(b.updatedAt) - time(a.updatedAt);
    case "used":
      return (a, b) => b.recallCount - a.recallCount || time(b.lastRecalledAt) - time(a.lastRecalledAt);
    case "dormant":
      return (a, b) => {
        const sleepA = isDormant(a, now);
        const sleepB = isDormant(b, now);
        if (sleepA !== sleepB) return sleepA ? -1 : 1;
        // Sleeping the longest first (last recall, or creation when never recalled); the awake ones, newest first.
        if (sleepA) return time(a.lastRecalledAt ?? a.createdAt) - time(b.lastRecalledAt ?? b.createdAt);
        return time(b.updatedAt) - time(a.updatedAt);
      };
  }
}

function toDraft(memory: MemorySummary): MemoryDraft {
  return { text: memory.text, scope: memory.scope, kind: memory.kind, pinned: memory.pinned };
}

/** Only the fields the user changed, or null when nothing changed. */
function changes(memory: MemorySummary, draft: MemoryDraft): MemoryPatch | null {
  const text = draft.text.trim();
  const patch: MemoryPatch = {
    ...(text !== memory.text ? { text } : {}),
    ...(draft.kind !== memory.kind ? { kind: draft.kind } : {}),
    ...(draft.scope !== memory.scope ? { scope: draft.scope } : {}),
    ...(draft.pinned !== memory.pinned ? { pinned: draft.pinned } : {}),
  };
  return Object.keys(patch).length === 0 ? null : patch;
}

function listFilter(tab: MemoryTab): { scope?: MemoryScope; forgotten?: boolean } {
  switch (tab) {
    case "trash":
      return { forgotten: true };
    case "common":
    case "personal":
      return { scope: tab };
    case "all":
      return {};
  }
}

export class MemoryScreen {
  tab = $state<MemoryTab>("all");
  /** Empty means every kind. */
  kinds = $state<MemoryKind[]>([]);
  query = $state("");
  sort = $state<MemorySort>("recent");
  items = $state<MemorySummary[]>([]);
  loading = $state(false);
  selectedId = $state<string | null>(null);
  draft = $state<MemoryDraft | null>(null);
  creating = $state(false);
  /** True while a save is in flight. */
  saving = $state(false);
  error = $state<string | null>(null);
  bench = $state<{ query: string; hits: MemoryTestHit[] } | null>(null);

  readonly #ports: MemoryPorts;
  #loadToken = 0;
  #benchToken = 0;

  /** What the list shows: kind filter, query and sort applied. */
  get visible(): MemorySummary[] {
    return visibleMemories(this.items, { kinds: this.kinds, query: this.query, sort: this.sort }, this.#ports.now());
  }
  /** The selected memory: from the list, or from the test bench when it is not in the current tab. */
  readonly selected = $derived<MemorySummary | null>(
    this.selectedId === null
      ? null
      : (this.items.find((m) => m.id === this.selectedId)
        ?? this.bench?.hits.find((hit) => hit.memory.id === this.selectedId)?.memory
        ?? null),
  );
  /** Something typed that Save would write. */
  readonly dirty = $derived.by(() => {
    if (this.draft === null) return false;
    if (this.creating) return this.draft.text.trim() !== "";
    return this.selected !== null && changes(this.selected, this.draft) !== null;
  });

  constructor(ports: MemoryPorts) {
    this.#ports = ports;
  }

  isDormant(memory: MemorySummary): boolean {
    return isDormant(memory, this.#ports.now());
  }

  /** Loads the list of the current tab; only the latest load may assign the items or report an error. */
  async load(): Promise<void> {
    const token = ++this.#loadToken;
    this.loading = true;
    try {
      const list = await this.#ports.list(listFilter(this.tab));
      if (token !== this.#loadToken) return;
      this.items = list;
      this.error = null;
      if (this.selectedId !== null && !this.creating && this.selected === null) this.#deselect();
    } catch {
      if (token !== this.#loadToken) return;
      this.error = "Impossible de charger les souvenirs.";
    } finally {
      if (token === this.#loadToken) this.loading = false;
    }
  }

  async setTab(tab: MemoryTab): Promise<void> {
    this.tab = tab;
    this.items = [];
    this.#deselect();
    await this.load();
  }

  select(id: string): void {
    const memory = this.items.find((m) => m.id === id) ?? this.bench?.hits.find((hit) => hit.memory.id === id)?.memory;
    if (memory === undefined) return;
    this.selectedId = id;
    this.draft = toDraft(memory);
    this.creating = false;
    this.error = null;
  }

  startCreate(): void {
    if (this.tab === "trash") return;
    this.selectedId = null;
    this.draft = { text: "", scope: "personal", kind: "fact", pinned: false };
    this.creating = true;
    this.error = null;
  }

  async save(): Promise<void> {
    const draft = this.draft;
    if (draft === null || this.saving || this.tab === "trash") return;
    if (this.creating) {
      await this.#create(draft);
      return;
    }
    const memory = this.selected;
    if (memory === null) return;
    const patch = changes(memory, draft);
    if (patch === null) return;
    const result = await this.#write(() => this.#ports.update(memory.id, patch));
    if (result === null) return;
    if (result.ok) {
      this.error = null;
      if (this.tab === "common" || this.tab === "personal") {
        // Moved to the other scope: it leaves this tab.
        if (result.memory.scope !== this.tab) {
          this.#remove(memory.id);
          return;
        }
      }
      this.#replace(result.memory);
      if (this.selectedId === memory.id) this.draft = toDraft(result.memory);
    } else {
      if (result.reason === "not_found") this.#remove(memory.id);
      this.error = WRITE_ERRORS[result.reason];
    }
  }

  async forget(): Promise<void> {
    const id = this.selectedId;
    if (id === null || this.tab === "trash") return;
    try {
      await this.#ports.forget(id);
    } catch {
      this.error = UNREACHABLE;
      return;
    }
    // Forgotten, or already gone: either way it leaves the list.
    this.#remove(id);
  }

  async restore(id: string): Promise<void> {
    let restored: MemorySummary | null;
    try {
      restored = await this.#ports.restore(id);
    } catch {
      this.error = UNREACHABLE;
      return;
    }
    this.#remove(id);
    this.error = restored === null ? WRITE_ERRORS.not_found : null;
  }

  /** Asks the brain what it would find for the search field, as a question. Leaves the list alone. */
  async runBench(): Promise<void> {
    const query = this.query.trim();
    if (query === "") return;
    const token = ++this.#benchToken;
    try {
      const hits = await this.#ports.test(query);
      if (token !== this.#benchToken) return;
      this.bench = { query, hits };
      this.error = null;
    } catch {
      if (token !== this.#benchToken) return;
      this.error = "Le test n'a pas pu se faire.";
    }
  }

  closeBench(): void {
    this.#benchToken++;
    this.bench = null;
  }

  async #create(draft: MemoryDraft): Promise<void> {
    const input: MemoryCreate = { text: draft.text.trim(), kind: draft.kind, scope: draft.scope, pinned: draft.pinned };
    const result = await this.#write(() => this.#ports.create(input));
    if (result === null) return;
    if (!result.ok) {
      this.error = WRITE_ERRORS[result.reason];
      return;
    }
    this.error = null;
    this.creating = false;
    this.draft = null;
    if (this.tab !== "all" && this.tab !== result.memory.scope) {
      // Created outside the current tab: show it where it lives.
      this.tab = "all";
      await this.load();
    } else {
      this.items = [result.memory, ...this.items.filter((m) => m.id !== result.memory.id)];
    }
    this.select(result.memory.id);
  }

  /** Runs a write; null (with the error set) when the brain was unreachable. */
  async #write(run: () => Promise<MemoryWriteResult>): Promise<MemoryWriteResult | null> {
    this.saving = true;
    try {
      return await run();
    } catch {
      this.error = UNREACHABLE;
      return null;
    } finally {
      this.saving = false;
    }
  }

  #replace(memory: MemorySummary): void {
    this.items = this.items.map((m) => (m.id === memory.id ? memory : m));
    const bench = this.bench;
    if (bench !== null) {
      this.bench = { ...bench, hits: bench.hits.map((hit) => (hit.memory.id === memory.id ? { ...hit, memory } : hit)) };
    }
  }

  #remove(id: string): void {
    this.items = this.items.filter((m) => m.id !== id);
    const bench = this.bench;
    if (bench !== null) this.bench = { ...bench, hits: bench.hits.filter((hit) => hit.memory.id !== id) };
    if (this.selectedId === id) this.#deselect();
  }

  #deselect(): void {
    this.selectedId = null;
    this.draft = null;
    this.creating = false;
    this.error = null;
  }
}
