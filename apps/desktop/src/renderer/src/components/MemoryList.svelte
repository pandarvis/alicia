<script lang="ts">
  import { MEMORY_KINDS, type MemoryKind, type MemorySummary } from "@alicia/protocol";
  import { flip } from "svelte/animate";
  import { fade } from "svelte/transition";
  import {
    formatDate, KIND_LABEL, KIND_PLURAL, SCOPE_LABEL, SORT_LABEL, TAB_LABEL,
  } from "../lib/memory-labels.ts";
  import type { MemoryScreen, MemorySort, MemoryTab } from "../lib/memory-screen.svelte.ts";
  import { focusMemory, neighbourId } from "../lib/memory-focus.ts";
  import { motion } from "../lib/motion.ts";
  import MemoryBench from "./MemoryBench.svelte";

  let { screen }: { screen: MemoryScreen } = $props();

  const uid = $props.id();
  const TABS: readonly MemoryTab[] = ["all", "common", "personal", "trash"];
  const SORTS: readonly MemorySort[] = ["recent", "used", "dormant"];

  const visible = $derived(screen.visible);
  const inTrash = $derived(screen.tab === "trash");
  const countLabel = $derived(`${visible.length} ${visible.length > 1 ? "souvenirs" : "souvenir"}`);
  const filtered = $derived(screen.query.trim() !== "" || screen.kinds.length > 0);

  function selectTab(tab: MemoryTab): void {
    if (tab !== screen.tab) void screen.setTab(tab);
  }

  /** Arrow keys move between the tabs (and select them), like any tab list. */
  function handleTabKeydown(event: KeyboardEvent): void {
    const index = TABS.indexOf(screen.tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    const tab = next === null ? undefined : TABS[next];
    if (tab === undefined) return;
    event.preventDefault();
    selectTab(tab);
    document.getElementById(`${uid}-tab-${tab}`)?.focus();
  }

  /** "Famille · Règle", and the extra word when there is one. */
  function meta(memory: MemorySummary, extra: string | null): string {
    return [SCOPE_LABEL[memory.scope], KIND_LABEL[memory.kind], ...(extra === null ? [] : [extra])].join(" · ");
  }

  /** Restores, then moves the focus to the next card of the trash (or the search field). */
  async function restore(id: string): Promise<void> {
    const next = neighbourId(visible.map((m) => m.id), id);
    await screen.restore(id);
    if (!screen.items.some((m) => m.id === id)) await focusMemory(next);
  }

  function toggleKind(kind: MemoryKind): void {
    screen.kinds = screen.kinds.includes(kind) ? screen.kinds.filter((k) => k !== kind) : [...screen.kinds, kind];
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && event.ctrlKey && !event.isComposing) {
      event.preventDefault();
      void screen.runBench();
    }
  }

  function handleSort(event: Event & { currentTarget: HTMLSelectElement }): void {
    const sort = SORTS.find((s) => s === event.currentTarget.value);
    if (sort !== undefined) screen.sort = sort;
  }
</script>

<div class="head">
  <div class="tabs" role="tablist" aria-label="Souvenirs">
    {#each TABS as tab (tab)}
      <button
        id="{uid}-tab-{tab}"
        role="tab"
        class:on={screen.tab === tab}
        aria-selected={screen.tab === tab}
        aria-controls="{uid}-panel"
        tabindex={screen.tab === tab ? 0 : -1}
        onclick={() => { selectTab(tab); }}
        onkeydown={handleTabKeydown}
        data-testid="memory-tab-{tab}"
      >{TAB_LABEL[tab]}</button>
    {/each}
  </div>
  <div class="search">
    <input
      type="search"
      bind:value={screen.query}
      onkeydown={handleSearchKeydown}
      placeholder="Chercher ou tester…"
      aria-label="Chercher un souvenir ou tester une question"
      title="Ctrl + Entrée : tester comme question"
      data-testid="memory-search"
    />
    <button class="test" onclick={() => void screen.runBench()} disabled={screen.query.trim() === ""} data-testid="memory-bench-run">
      Tester comme question
    </button>
    {#if !inTrash}
      <button class="add" onclick={() => { screen.startCreate(); }} title="Nouveau souvenir" aria-label="Nouveau souvenir" data-testid="memory-new" transition:fade={{ duration: motion(150) }}>+</button>
    {/if}
  </div>
  <div class="chips" role="group" aria-label="Types">
    {#each MEMORY_KINDS as kind (kind)}
      <button class="chip" class:on={screen.kinds.includes(kind)} aria-pressed={screen.kinds.includes(kind)} onclick={() => { toggleKind(kind); }} data-testid="memory-kind-{kind}">
        {KIND_PLURAL[kind]}
      </button>
    {/each}
  </div>
  <div class="summary">
    <span class="count">{screen.bench === null && visible.length > 0 ? countLabel : ""}</span>
    <select value={screen.sort} onchange={handleSort} aria-label="Trier" data-testid="memory-sort">
      {#each SORTS as sort (sort)}
        <option value={sort}>{SORT_LABEL[sort]}</option>
      {/each}
    </select>
  </div>
</div>

<div class="panes" id="{uid}-panel" role="tabpanel" aria-labelledby="{uid}-tab-{screen.tab}">
  {#if screen.bench !== null}
    <div class="pane" transition:fade={{ duration: motion(160) }}>
      <MemoryBench {screen} />
    </div>
  {:else}
    <div class="pane" transition:fade={{ duration: motion(160) }}>
      {#if screen.items.length === 0 && screen.loading}
        <p class="empty" in:fade={{ duration: motion(150) }}>Chargement…</p>
      {:else if screen.items.length === 0}
        <p class="empty" in:fade={{ duration: motion(150) }} data-testid="memory-empty">
          {inTrash ? "La corbeille est vide." : "Aucun souvenir ici pour l'instant."}
        </p>
      {:else if visible.length === 0 && filtered}
        <p class="empty" in:fade={{ duration: motion(150) }} data-testid="memory-empty">Aucun souvenir ne correspond.</p>
      {/if}
      <ul class="cards">
        {#each visible as memory (memory.id)}
          {@const dormant = screen.isDormant(memory)}
          <li animate:flip={{ duration: motion(200) }} in:fade={{ duration: motion(150) }} out:fade={{ duration: motion(120) }}>
            {#if inTrash}
              <div class="card" data-testid="memory-card" data-dormant={dormant ? "true" : "false"}>
                <span class="body">
                  <span class="text">{memory.text}</span>
                  <span class="meta">{meta(memory, memory.forgottenAt === null ? null : `oublié le ${formatDate(memory.forgottenAt)}`)}</span>
                </span>
                <button class="restore" onclick={() => void restore(memory.id)} data-focus-memory={memory.id} data-testid="memory-restore">Récupérer</button>
              </div>
            {:else}
              <button
                class="card"
                class:selected={memory.id === screen.selectedId}
                class:dormant
                aria-current={memory.id === screen.selectedId ? "true" : undefined}
                title={dormant ? "Pas rappelé depuis longtemps (ou jamais)" : undefined}
                onclick={() => { screen.select(memory.id); }}
                data-focus-memory={memory.id}
                data-testid="memory-card"
                data-dormant={dormant ? "true" : "false"}
              >
                {#if memory.pinned}<span class="pin" role="img" aria-label="Épinglé">📌</span>{:else}<span class="pin"></span>{/if}
                <span class="body">
                  <span class="text">{memory.text}</span>
                  <span class="meta">{meta(memory, dormant ? "dort" : null)}</span>
                </span>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .head { flex: none; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px 10px; }
  button { border: 0; background: none; cursor: pointer; transition: background var(--duration) ease, color var(--duration) ease, border-color var(--duration) ease, opacity var(--duration) ease; }
  button:disabled { cursor: default; opacity: 0.5; }
  .tabs { display: flex; gap: 4px; }
  .tabs button { padding: 4px 12px; border-radius: 8px; background: var(--surface); color: var(--cream-muted); font-size: 14px; }
  .tabs button:hover { color: var(--cream); }
  .tabs button.on { background: var(--surface-raised); color: var(--cream); font-weight: 700; }
  .search { display: flex; gap: 6px; align-items: center; }
  input {
    flex: 1; min-width: 0; background: var(--surface); border: 1px solid transparent; border-radius: 9px;
    padding: 6px 10px; outline: none; transition: border-color var(--duration) ease;
  }
  input:focus { border-color: var(--surface-raised); }
  input::placeholder { color: var(--muted); }
  .test { flex: none; padding: 6px 10px; border-radius: 9px; border: 1px solid var(--surface-raised); color: var(--cream-muted); font-size: 13px; }
  .test:hover:not(:disabled) { border-color: var(--sage); color: var(--cream); }
  .add { flex: none; width: 32px; height: 32px; border-radius: 9px; background: var(--sage); color: var(--night); font-weight: 800; font-size: 18px; line-height: 1; }
  .add:hover { background: color-mix(in srgb, var(--sage) 85%, var(--cream)); }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .summary { display: flex; gap: 8px; align-items: center; justify-content: space-between; min-height: 24px; }
  .chip { padding: 2px 9px; border-radius: 999px; border: 1px solid var(--surface-raised); color: var(--cream-muted); font-size: 12px; }
  .chip:hover { color: var(--cream); }
  .chip.on { border-color: var(--sage); color: var(--sage); }
  select {
    flex: none; background: var(--surface); color: var(--cream-muted); border: 0; border-radius: 8px;
    padding: 3px 6px; font: inherit; font-size: 12px; cursor: pointer;
  }
  .panes { flex: 1; min-height: 0; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); }
  .pane { grid-area: 1 / 1; min-height: 0; overflow-y: auto; padding: 0 16px 16px; }
  .count { margin-left: 2px; font-size: 12px; color: var(--muted); }
  .empty { margin: 24px 4px; color: var(--muted); text-align: center; }
  .cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .card {
    width: 100%; display: flex; gap: 8px; align-items: flex-start; text-align: left;
    background: var(--surface); border-radius: 10px; padding: 8px 10px;
    box-shadow: 0 0 0 1px transparent; transition: box-shadow var(--duration) ease, background var(--duration) ease, opacity var(--duration) ease;
  }
  button.card:hover { background: color-mix(in srgb, var(--surface) 70%, var(--surface-raised)); }
  .card.selected { box-shadow: 0 0 0 1px var(--sage); }
  .card.dormant { opacity: 0.55; }
  .card.dormant.selected, .card.dormant:hover { opacity: 0.85; }
  .pin { flex: none; width: 16px; color: var(--amber); font-size: 13px; line-height: 1.45; }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .text {
    color: var(--cream); line-height: 1.4; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .meta { font-size: 12px; color: var(--muted); }
  .restore { flex: none; align-self: center; padding: 4px 10px; border-radius: 8px; background: var(--surface-raised); color: var(--sage); font-weight: 700; font-size: 13px; }
  .restore:hover { background: var(--night-deep); }
</style>
