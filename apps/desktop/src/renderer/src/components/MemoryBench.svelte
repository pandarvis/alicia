<script lang="ts">
  import Pin from "@lucide/svelte/icons/pin";
  import { fade } from "svelte/transition";
  import { hitReasons, KIND_LABEL, SCOPE_LABEL } from "../lib/memory-labels.ts";
  import { proximity, type MemoryScreen } from "../lib/memory-screen.svelte.ts";
  import { motion } from "../lib/motion.ts";

  let { screen }: { screen: MemoryScreen } = $props();

  const bench = $derived(screen.bench);
</script>

{#if bench !== null}
  <div class="bench" data-testid="memory-bench">
    <header>
      <div class="what">
        <h3>Ce qu'Alicia retrouverait</h3>
        <p class="question">« {bench.query} »</p>
      </div>
      <button class="close" onclick={() => { screen.closeBench(); }} data-testid="memory-bench-close">Fermer le test</button>
    </header>
    {#if bench.hits.length === 0}
      <p class="empty" in:fade={{ duration: motion(150) }}>Alicia ne retrouverait aucun souvenir pour cette question.</p>
    {:else}
      <p class="hint">Dans l'ordre où elle les reçoit. Ce test ne compte pas comme un rappel.</p>
      <ol>
        {#each bench.hits as hit (hit.memory.id)}
          {@const closeness = proximity(hit)}
          <li in:fade={{ duration: motion(150) }}>
            <button
              class="hit"
              class:selected={hit.memory.id === screen.selectedId}
              aria-current={hit.memory.id === screen.selectedId ? "true" : undefined}
              onclick={() => { screen.select(hit.memory.id); }}
              disabled={screen.tab === "trash"}
              data-testid="memory-bench-hit"
            >
              <span class="rank">{hit.rank}</span>
              <span class="body">
                <span class="text">{#if hit.memory.pinned}<span class="pin" role="img" aria-label="Épinglé"><Pin size={12} aria-hidden="true" /></span>{/if}{hit.memory.text}</span>
                <span class="meta">{SCOPE_LABEL[hit.memory.scope]} · {KIND_LABEL[hit.memory.kind]}</span>
                <span class="why" data-testid="memory-bench-reasons">{hitReasons(hit).join(" + ")}</span>
                <span class="closeness">
                  <span class="bar" role="meter" aria-label="Proximité de sens" aria-valuemin={0} aria-valuemax={100} aria-valuenow={closeness}>
                    <span class="fill" style:width="{closeness}%"></span>
                  </span>
                  <span class="percent">{closeness} %</span>
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
{/if}

<style>
  .bench { display: flex; flex-direction: column; gap: 8px; }
  header { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }
  .what { min-width: 0; }
  h3 { margin: 0; font-size: 14px; color: var(--sage); }
  .question { margin: 2px 0 0; color: var(--cream); overflow-wrap: anywhere; }
  button { border: 0; background: none; cursor: pointer; transition: background var(--duration) ease, color var(--duration) ease, box-shadow var(--duration) ease; }
  .close { flex: none; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--surface-raised); color: var(--cream-muted); font-size: 13px; }
  .close:hover { border-color: var(--sage); color: var(--cream); }
  .hint { margin: 0; font-size: 12px; color: var(--muted); }
  .empty { margin: 24px 4px; color: var(--muted); text-align: center; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .hit {
    width: 100%; display: flex; gap: 10px; align-items: flex-start; text-align: left;
    background: var(--surface); border-radius: 10px; padding: 8px 10px; box-shadow: 0 0 0 1px transparent;
  }
  /* From the trash, the hits are only shown: a memory is edited from the other tabs. */
  .hit:disabled { cursor: default; }
  .hit:hover:not(:disabled) { background: color-mix(in srgb, var(--surface) 70%, var(--surface-raised)); }
  .hit.selected { box-shadow: 0 0 0 1px var(--sage); }
  .rank { flex: none; width: 20px; color: var(--sage); font-weight: 800; }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .text {
    color: var(--cream); line-height: 1.4; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pin { color: var(--amber); display: inline-block; vertical-align: -1px; margin-right: 4px; }
  .meta { font-size: 12px; color: var(--muted); }
  .why { font-size: 12px; color: var(--amber); }
  .closeness { display: flex; align-items: center; gap: 8px; }
  .bar { flex: 1; max-width: 180px; height: 5px; border-radius: 999px; background: var(--night-deep); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: inherit; background: var(--sage); }
  .percent { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
