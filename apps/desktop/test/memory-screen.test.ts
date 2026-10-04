import type { MemoryCreate, MemoryPatch, MemorySummary, MemoryTestHit } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import type { MemoryWriteResult } from "../src/renderer/src/lib/brain-client.ts";
import {
  isDormant, MemoryScreen, proximity, visibleMemories, type MemoryPorts,
} from "../src/renderer/src/lib/memory-screen.svelte.ts";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const DAY = 24 * 3_600_000;

function ago(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function memory(n: number, overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: id(n),
    scope: "personal",
    kind: "fact",
    text: `Souvenir ${n}`,
    pinned: false,
    source: "manual",
    conversationId: null,
    conversationTitle: null,
    createdAt: ago(100),
    updatedAt: ago(100),
    recallCount: 0,
    lastRecalledAt: null,
    forgottenAt: null,
    ...overrides,
  };
}

function patched(m: MemorySummary, patch: MemoryPatch): MemorySummary {
  return {
    ...m,
    text: patch.text ?? m.text,
    kind: patch.kind ?? m.kind,
    scope: patch.scope ?? m.scope,
    pinned: patch.pinned ?? m.pinned,
  };
}

function hit(similarity: number, m: MemorySummary = memory(1)): MemoryTestHit {
  return { memory: m, rank: 1, textMatch: true, similarity };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Calls {
  list: { scope?: string; forgotten?: boolean }[];
  create: MemoryCreate[];
  update: { id: string; patch: MemoryPatch }[];
  forget: string[];
  restore: string[];
  test: string[];
}

function setup(stored: MemorySummary[] = [], overrides: Partial<MemoryPorts> = {}) {
  const calls: Calls = { list: [], create: [], update: [], forget: [], restore: [], test: [] };
  const screen = new MemoryScreen({
    list: (filter) => {
      calls.list.push(filter);
      return Promise.resolve(stored);
    },
    create: (input) => {
      calls.create.push(input);
      return Promise.resolve({ ok: true, memory: memory(99, { ...input, pinned: input.pinned ?? false }) });
    },
    update: (memoryId, patch) => {
      calls.update.push({ id: memoryId, patch });
      const current = stored.find((m) => m.id === memoryId) ?? memory(0);
      return Promise.resolve({ ok: true, memory: patched(current, patch) });
    },
    forget: (memoryId) => {
      calls.forget.push(memoryId);
      return Promise.resolve(true);
    },
    restore: (memoryId) => {
      calls.restore.push(memoryId);
      return Promise.resolve(stored.find((m) => m.id === memoryId) ?? null);
    },
    test: (q) => {
      calls.test.push(q);
      return Promise.resolve([]);
    },
    now: () => NOW,
    ...overrides,
  });
  return { screen, calls };
}

async function ready(stored: MemorySummary[], overrides: Partial<MemoryPorts> = {}) {
  const made = setup(stored, overrides);
  await made.screen.load();
  return made;
}

describe("proximity", () => {
  test("normalises between the 0.82 floor and 1, clamped", () => {
    expect(proximity(hit(0.82))).toBe(0);
    expect(proximity(hit(1))).toBe(100);
    expect(proximity(hit(0.91))).toBe(50);
    expect(proximity(hit(0.5))).toBe(0);
    expect(proximity(hit(0))).toBe(0);
    expect(proximity(hit(0.95))).toBe(72);
  });
});

describe("isDormant", () => {
  test("never recalled sleeps", () => {
    expect(isDormant(memory(1), NOW)).toBe(true);
  });

  test("recalled within 60 days is awake, older sleeps", () => {
    expect(isDormant(memory(1, { recallCount: 3, lastRecalledAt: ago(59) }), NOW)).toBe(false);
    expect(isDormant(memory(1, { recallCount: 3, lastRecalledAt: ago(61) }), NOW)).toBe(true);
  });

  test("the screen uses its clock", () => {
    const { screen } = setup();
    expect(screen.isDormant(memory(1, { recallCount: 1, lastRecalledAt: ago(1) }))).toBe(false);
    expect(screen.isDormant(memory(1))).toBe(true);
  });
});

describe("visibleMemories", () => {
  const view = { kinds: [], query: "", sort: "recent" } as const;

  test("filters by kind; none selected means all", () => {
    const items = [memory(1, { kind: "rule" }), memory(2, { kind: "habit" }), memory(3, { kind: "rule" })];
    expect(visibleMemories(items, view, NOW)).toHaveLength(3);
    expect(visibleMemories(items, { ...view, kinds: ["rule"] }, NOW).map((m) => m.id)).toEqual([id(1), id(3)]);
    expect(visibleMemories(items, { ...view, kinds: ["rule", "habit"] }, NOW)).toHaveLength(3);
  });

  test("query: every word present, without accents or case", () => {
    const items = [
      memory(1, { text: "Kévin adore les LASAGNES de mamie" }),
      memory(2, { text: "Élodie cuisine des lasagnes" }),
      memory(3, { text: "Le chat s'appelle Moka" }),
    ];
    const ids = (query: string) => visibleMemories(items, { ...view, query }, NOW).map((m) => m.id);
    expect(ids("lasagnes")).toEqual([id(1), id(2)]);
    expect(ids("KEVIN lasagnes")).toEqual([id(1)]);
    expect(ids("elodie")).toEqual([id(2)]);
    expect(ids("lasagnes moka")).toEqual([]);
    expect(ids("   ")).toHaveLength(3);
    expect(ids("s'appelle")).toEqual([id(3)]);
  });

  test("kind and query combine", () => {
    const items = [memory(1, { kind: "rule", text: "Volets fermés" }), memory(2, { kind: "fact", text: "Volets bleus" })];
    expect(visibleMemories(items, { ...view, kinds: ["rule"], query: "volets" }, NOW).map((m) => m.id)).toEqual([id(1)]);
  });

  test("sort recent: newest update first", () => {
    const items = [memory(1, { updatedAt: ago(5) }), memory(2, { updatedAt: ago(1) }), memory(3, { updatedAt: ago(3) })];
    expect(visibleMemories(items, view, NOW).map((m) => m.id)).toEqual([id(2), id(3), id(1)]);
  });

  test("sort used: most recalled first, then most recently recalled", () => {
    const items = [
      memory(1, { recallCount: 2, lastRecalledAt: ago(10) }),
      memory(2, { recallCount: 5, lastRecalledAt: ago(30) }),
      memory(3, { recallCount: 2, lastRecalledAt: ago(2) }),
      memory(4),
    ];
    expect(visibleMemories(items, { ...view, sort: "used" }, NOW).map((m) => m.id)).toEqual([id(2), id(3), id(1), id(4)]);
  });

  test("sort dormant: sleeping ones first, longest asleep first; the awake ones after, newest first", () => {
    const items = [
      memory(1, { recallCount: 4, lastRecalledAt: ago(2), updatedAt: ago(50) }),
      memory(2, { createdAt: ago(20) }),
      memory(3, { recallCount: 1, lastRecalledAt: ago(90) }),
      memory(4, { createdAt: ago(200) }),
      memory(5, { recallCount: 4, lastRecalledAt: ago(5), updatedAt: ago(10) }),
    ];
    expect(visibleMemories(items, { ...view, sort: "dormant" }, NOW).map((m) => m.id)).toEqual([
      id(4), id(3), id(2), id(5), id(1),
    ]);
  });

  test("does not reorder the source list", () => {
    const items = [memory(1, { updatedAt: ago(5) }), memory(2, { updatedAt: ago(1) })];
    visibleMemories(items, view, NOW);
    expect(items.map((m) => m.id)).toEqual([id(1), id(2)]);
  });
});

describe("MemoryScreen: loading", () => {
  test("starts on all, empty", () => {
    const { screen } = setup();
    expect(screen.tab).toBe("all");
    expect(screen.items).toEqual([]);
    expect(screen.selected).toBeNull();
    expect(screen.dirty).toBe(false);
  });

  test("each tab asks the right list", async () => {
    const { screen, calls } = setup([memory(1)]);
    await screen.load();
    await screen.setTab("common");
    await screen.setTab("personal");
    await screen.setTab("trash");
    await screen.setTab("all");
    expect(calls.list).toEqual([{}, { scope: "common" }, { scope: "personal" }, { forgotten: true }, {}]);
  });

  test("loading flag, items assigned", async () => {
    const pending = deferred<MemorySummary[]>();
    const { screen } = setup([], { list: () => pending.promise });
    const loading = screen.load();
    expect(screen.loading).toBe(true);
    pending.resolve([memory(1)]);
    await loading;
    expect(screen.loading).toBe(false);
    expect(screen.items.map((m) => m.id)).toEqual([id(1)]);
  });

  test("a stale response is ignored", async () => {
    const first = deferred<MemorySummary[]>();
    const second = deferred<MemorySummary[]>();
    const answers = [first, second];
    let call = 0;
    const { screen } = setup([], { list: () => answers[call++]?.promise ?? Promise.resolve([]) });
    const slow = screen.setTab("common");
    const fast = screen.setTab("personal");
    second.resolve([memory(2, { scope: "personal" })]);
    await fast;
    first.resolve([memory(1, { scope: "common" })]);
    await slow;
    expect(screen.tab).toBe("personal");
    expect(screen.items.map((m) => m.id)).toEqual([id(2)]);
    expect(screen.loading).toBe(false);
  });

  test("a failed load says so in French and keeps nothing wrong", async () => {
    const { screen } = setup([], { list: () => Promise.reject(new Error("down")) });
    await screen.load();
    expect(screen.error).toBe("Impossible de charger les souvenirs.");
    expect(screen.loading).toBe(false);
  });

  test("switching tab clears the selection and the old items", async () => {
    const pending = deferred<MemorySummary[]>();
    const { screen } = setup([], { list: () => pending.promise });
    screen.items = [memory(1)];
    screen.select(id(1));
    const switching = screen.setTab("trash");
    expect(screen.items).toEqual([]);
    expect(screen.selectedId).toBeNull();
    expect(screen.draft).toBeNull();
    pending.resolve([]);
    await switching;
  });

  test("a reload keeps the selection while the memory is still there, drops it otherwise", async () => {
    let stored = [memory(1), memory(2)];
    const { screen } = setup([], { list: () => Promise.resolve(stored) });
    await screen.load();
    screen.select(id(1));
    await screen.load();
    expect(screen.selectedId).toBe(id(1));
    stored = [memory(2)];
    await screen.load();
    expect(screen.selectedId).toBeNull();
    expect(screen.draft).toBeNull();
  });

  test("visible follows kinds, query and sort", async () => {
    const { screen } = await ready([
      memory(1, { kind: "rule", text: "Volets fermés la nuit", updatedAt: ago(5) }),
      memory(2, { kind: "fact", text: "Volets bleus", updatedAt: ago(1) }),
    ]);
    expect(screen.visible.map((m) => m.id)).toEqual([id(2), id(1)]);
    screen.kinds = ["rule"];
    expect(screen.visible.map((m) => m.id)).toEqual([id(1)]);
    screen.kinds = [];
    screen.query = "bleus";
    expect(screen.visible.map((m) => m.id)).toEqual([id(2)]);
    screen.query = "";
    screen.sort = "dormant";
    expect(screen.visible).toHaveLength(2);
  });
});

describe("MemoryScreen: draft and save", () => {
  test("select copies the memory into the draft; not dirty until edited", async () => {
    const { screen } = await ready([memory(1, { text: "Thé le matin", kind: "habit", pinned: true, scope: "common" })]);
    screen.select(id(1));
    expect(screen.selectedId).toBe(id(1));
    expect(screen.selected?.id).toBe(id(1));
    expect(screen.draft).toEqual({ text: "Thé le matin", kind: "habit", pinned: true, scope: "common" });
    expect(screen.dirty).toBe(false);
    if (screen.draft !== null) screen.draft.text = "Café le matin";
    expect(screen.dirty).toBe(true);
    if (screen.draft !== null) screen.draft.text = "Thé le matin";
    expect(screen.dirty).toBe(false);
  });

  test("selecting an unknown id does nothing", async () => {
    const { screen } = await ready([memory(1)]);
    screen.select(id(7));
    expect(screen.selectedId).toBeNull();
    expect(screen.draft).toBeNull();
  });

  test("save sends only the changed fields", async () => {
    const { screen, calls } = await ready([memory(1, { text: "Thé" })]);
    screen.select(id(1));
    if (screen.draft !== null) {
      screen.draft.pinned = true;
      screen.draft.kind = "preference";
    }
    await screen.save();
    expect(calls.update).toEqual([{ id: id(1), patch: { kind: "preference", pinned: true } }]);
  });

  test("save with a text change sends the trimmed text", async () => {
    const { screen, calls } = await ready([memory(1, { text: "Thé" })]);
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.text = "  Café  ";
    await screen.save();
    expect(calls.update).toEqual([{ id: id(1), patch: { text: "Café" } }]);
  });

  test("save refreshes the item and the draft; no longer dirty", async () => {
    const { screen } = await ready([memory(1, { text: "Thé" })]);
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.text = "Café";
    await screen.save();
    expect(screen.items[0]?.text).toBe("Café");
    expect(screen.selectedId).toBe(id(1));
    expect(screen.dirty).toBe(false);
    expect(screen.saving).toBe(false);
    expect(screen.error).toBeNull();
  });

  test("save with nothing changed calls nothing", async () => {
    const { screen, calls } = await ready([memory(1)]);
    screen.select(id(1));
    await screen.save();
    expect(calls.update).toEqual([]);
  });

  test("moving to the other scope removes it from a scoped tab", async () => {
    const { screen } = setup([memory(1, { scope: "personal" })]);
    await screen.setTab("personal");
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.scope = "common";
    await screen.save();
    expect(screen.items).toEqual([]);
    expect(screen.selectedId).toBeNull();
  });

  test("moving to the other scope keeps it in the all tab", async () => {
    const { screen } = await ready([memory(1, { scope: "personal" })]);
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.scope = "common";
    await screen.save();
    expect(screen.items[0]?.scope).toBe("common");
    expect(screen.selectedId).toBe(id(1));
  });

  test("a write in the trash is refused", async () => {
    const { screen, calls } = setup([memory(1)]);
    await screen.setTab("trash");
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.text = "Autre";
    await screen.save();
    expect(calls.update).toEqual([]);
  });

  test("an unreachable brain reports it and keeps the draft", async () => {
    const { screen } = await ready([memory(1)], { update: () => Promise.reject(new Error("down")) });
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.text = "Autre";
    await screen.save();
    expect(screen.error).toBe("Alicia n'est pas joignable pour l'instant.");
    expect(screen.draft?.text).toBe("Autre");
    expect(screen.saving).toBe(false);
  });

  test("a second save while one is running is ignored", async () => {
    const pending = deferred<MemoryWriteResult>();
    let updates = 0;
    const { screen } = await ready([memory(1)], {
      update: () => {
        updates++;
        return pending.promise;
      },
    });
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.text = "Autre";
    const first = screen.save();
    expect(screen.saving).toBe(true);
    await screen.save();
    pending.resolve({ ok: true, memory: memory(1, { text: "Autre" }) });
    await first;
    expect(updates).toBe(1);
  });

  const refusals = [
    ["duplicate", "Alicia sait déjà ça."],
    ["secret", "Alicia ne retient ni mots de passe ni codes."],
    ["empty", "Le souvenir est vide."],
    ["not_found", "Ce souvenir n'existe plus (supprimé ailleurs ?)."],
    ["invalid", "Vérifie le texte (1 000 caractères au plus)."],
  ] as const;

  test.each(refusals)("update refused as %s: French message, draft kept", async (reason, message) => {
    const { screen } = await ready([memory(1)], { update: () => Promise.resolve({ ok: false, reason }) });
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.text = "Autre";
    await screen.save();
    expect(screen.error).toBe(message);
    if (reason === "not_found") {
      expect(screen.items).toEqual([]);
      expect(screen.selectedId).toBeNull();
    } else {
      expect(screen.draft?.text).toBe("Autre");
      expect(screen.items).toHaveLength(1);
    }
  });

  test.each(refusals)("create refused as %s: French message, draft kept", async (reason, message) => {
    const { screen } = await ready([], { create: () => Promise.resolve({ ok: false, reason }) });
    screen.startCreate();
    if (screen.draft !== null) screen.draft.text = "Quelque chose";
    await screen.save();
    expect(screen.error).toBe(message);
    expect(screen.creating).toBe(true);
    expect(screen.draft?.text).toBe("Quelque chose");
  });

  test("selecting something clears a previous error", async () => {
    const { screen } = await ready([memory(1)], { update: () => Promise.resolve({ ok: false, reason: "duplicate" }) });
    screen.select(id(1));
    if (screen.draft !== null) screen.draft.text = "Autre";
    await screen.save();
    expect(screen.error).not.toBeNull();
    screen.select(id(1));
    expect(screen.error).toBeNull();
  });
});

describe("MemoryScreen: creation", () => {
  test("startCreate opens an empty personal fact draft, nothing selected", async () => {
    const { screen } = await ready([memory(1)]);
    screen.select(id(1));
    screen.startCreate();
    expect(screen.creating).toBe(true);
    expect(screen.selectedId).toBeNull();
    expect(screen.draft).toEqual({ text: "", scope: "personal", kind: "fact", pinned: false });
    expect(screen.dirty).toBe(false);
    if (screen.draft !== null) screen.draft.text = "Le chat s'appelle Moka";
    expect(screen.dirty).toBe(true);
  });

  test("save creates, adds to the list and selects the new memory", async () => {
    const { screen, calls } = await ready([memory(1)]);
    screen.startCreate();
    if (screen.draft !== null) {
      screen.draft.text = "  Le chat s'appelle Moka ";
      screen.draft.scope = "common";
      screen.draft.pinned = true;
    }
    await screen.save();
    expect(calls.create).toEqual([{ text: "Le chat s'appelle Moka", kind: "fact", scope: "common", pinned: true }]);
    expect(screen.items.map((m) => m.id)).toEqual([id(99), id(1)]);
    expect(screen.creating).toBe(false);
    expect(screen.selectedId).toBe(id(99));
    expect(screen.draft?.text).toBe("Le chat s'appelle Moka");
    expect(screen.dirty).toBe(false);
  });

  test("created outside the current tab: back to all so it shows", async () => {
    const stored: MemorySummary[] = [memory(1, { scope: "common" })];
    const { screen, calls } = setup([], {
      list: (filter) => {
        calls.list.push(filter);
        return Promise.resolve(stored);
      },
      create: (input) => {
        const created = memory(99, { ...input, pinned: false });
        stored.unshift(created);
        return Promise.resolve({ ok: true, memory: created });
      },
    });
    await screen.setTab("common");
    screen.startCreate();
    if (screen.draft !== null) screen.draft.text = "Un truc perso";
    await screen.save();
    expect(screen.tab).toBe("all");
    expect(calls.list.at(-1)).toEqual({});
    expect(screen.items.map((m) => m.id)).toEqual([id(99), id(1)]);
    expect(screen.selectedId).toBe(id(99));
  });

  test("blank text is not saved as dirty; the trash cannot start a creation", async () => {
    const { screen } = setup([memory(1)]);
    screen.startCreate();
    if (screen.draft !== null) screen.draft.text = "   ";
    expect(screen.dirty).toBe(false);
    await screen.setTab("trash");
    screen.startCreate();
    expect(screen.creating).toBe(false);
    expect(screen.draft).toBeNull();
  });
});

describe("MemoryScreen: forget and restore", () => {
  test("forget removes the selected memory and deselects", async () => {
    const { screen, calls } = await ready([memory(1), memory(2)]);
    screen.select(id(1));
    await screen.forget();
    expect(calls.forget).toEqual([id(1)]);
    expect(screen.items.map((m) => m.id)).toEqual([id(2)]);
    expect(screen.selectedId).toBeNull();
    expect(screen.draft).toBeNull();
  });

  test("forget of an already-gone memory still clears it", async () => {
    const { screen } = await ready([memory(1)], { forget: () => Promise.resolve(false) });
    screen.select(id(1));
    await screen.forget();
    expect(screen.items).toEqual([]);
    expect(screen.error).toBeNull();
  });

  test("forget with nothing selected, or unreachable brain", async () => {
    const { screen, calls } = await ready([memory(1)], { forget: () => Promise.reject(new Error("down")) });
    await screen.forget();
    expect(calls.forget).toEqual([]);
    screen.select(id(1));
    await screen.forget();
    expect(screen.error).toBe("Alicia n'est pas joignable pour l'instant.");
    expect(screen.items).toHaveLength(1);
  });

  test("restore takes it out of the trash list", async () => {
    const trash = [memory(1, { forgottenAt: ago(2) }), memory(2, { forgottenAt: ago(1) })];
    const { screen, calls } = setup(trash);
    await screen.setTab("trash");
    await screen.restore(id(1));
    expect(calls.restore).toEqual([id(1)]);
    expect(screen.items.map((m) => m.id)).toEqual([id(2)]);
    expect(screen.error).toBeNull();
  });

  test("restore of something already gone says so", async () => {
    const { screen } = setup([memory(1, { forgottenAt: ago(40) })], { restore: () => Promise.resolve(null) });
    await screen.setTab("trash");
    await screen.restore(id(1));
    expect(screen.items).toEqual([]);
    expect(screen.error).toBe("Ce souvenir n'existe plus (supprimé ailleurs ?).");
  });

  test("restoring the selected trash memory deselects it; forgetting is not offered in the trash", async () => {
    const { screen, calls } = setup([memory(1, { forgottenAt: ago(2) })]);
    await screen.setTab("trash");
    screen.select(id(1));
    await screen.forget();
    expect(calls.forget).toEqual([]);
    await screen.restore(id(1));
    expect(screen.selectedId).toBeNull();
  });
});

describe("MemoryScreen: test bench", () => {
  test("runs the search field as a question, keeps query and hits, leaves the list alone", async () => {
    const lasagnes = memory(5, { text: "Kévin adore les lasagnes" });
    const hits = [hit(0.95, lasagnes)];
    const { screen, calls } = await ready([memory(1), memory(2)], { test: (q) => {
      calls.test.push(q);
      return Promise.resolve(hits);
    } });
    screen.query = "  Quel est mon plat préféré ? ";
    await screen.runBench();
    expect(calls.test).toEqual(["Quel est mon plat préféré ?"]);
    expect(screen.bench).toEqual({ query: "Quel est mon plat préféré ?", hits });
    expect(screen.items.map((m) => m.id)).toEqual([id(1), id(2)]);
    expect(calls.list).toHaveLength(1);
  });

  test("a blank question asks nothing", async () => {
    const { screen, calls } = setup();
    screen.query = "   ";
    await screen.runBench();
    expect(calls.test).toEqual([]);
    expect(screen.bench).toBeNull();
  });

  test("closeBench drops the results; a late answer does not bring them back", async () => {
    const pending = deferred<MemoryTestHit[]>();
    const { screen } = setup([], { test: () => pending.promise });
    screen.query = "lasagnes";
    const running = screen.runBench();
    screen.closeBench();
    pending.resolve([hit(0.9)]);
    await running;
    expect(screen.bench).toBeNull();
  });

  test("the latest question wins over an older, slower one", async () => {
    const first = deferred<MemoryTestHit[]>();
    const second = deferred<MemoryTestHit[]>();
    const answers = [first, second];
    let call = 0;
    const { screen } = setup([], { test: () => answers[call++]?.promise ?? Promise.resolve([]) });
    screen.query = "un";
    const one = screen.runBench();
    screen.query = "deux";
    const two = screen.runBench();
    second.resolve([hit(0.9, memory(2))]);
    await two;
    first.resolve([hit(0.9, memory(1))]);
    await one;
    expect(screen.bench?.query).toBe("deux");
    expect(screen.bench?.hits[0]?.memory.id).toBe(id(2));
  });

  test("a failed test says so", async () => {
    const { screen } = setup([], { test: () => Promise.reject(new Error("down")) });
    screen.query = "lasagnes";
    await screen.runBench();
    expect(screen.error).toBe("Le test n'a pas pu se faire.");
    expect(screen.bench).toBeNull();
  });

  test("a hit outside the current list can be selected, edited and forgotten", async () => {
    const elsewhere = memory(5, { scope: "common", text: "Plat préféré : lasagnes" });
    const { screen } = await ready([memory(1)], {
      test: () => Promise.resolve([hit(0.95, elsewhere)]),
      update: (_id, patch) => Promise.resolve({ ok: true, memory: patched(elsewhere, patch) }),
    });
    screen.query = "plat préféré";
    await screen.runBench();
    screen.select(id(5));
    expect(screen.selected?.text).toBe("Plat préféré : lasagnes");
    expect(screen.draft?.scope).toBe("common");
    if (screen.draft !== null) screen.draft.pinned = true;
    await screen.save();
    expect(screen.bench?.hits[0]?.memory.pinned).toBe(true);
    expect(screen.items.map((m) => m.id)).toEqual([id(1)]);
    await screen.forget();
    expect(screen.bench?.hits).toEqual([]);
    expect(screen.selectedId).toBeNull();
  });
});
