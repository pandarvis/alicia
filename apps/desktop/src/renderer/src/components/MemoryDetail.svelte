<script lang="ts">
  import { MEMORY_KINDS, type MemoryScope } from "@alicia/protocol";
  import { fade } from "svelte/transition";
  import { KIND_LABEL, provenance, SCOPE_LABEL, usage } from "../lib/memory-labels.ts";
  import { focusMemory, neighbourId } from "../lib/memory-focus.ts";
  import type { MemoryScreen } from "../lib/memory-screen.svelte.ts";
  import { motion } from "../lib/motion.ts";

  let { screen, conversationBusy, onOpenConversation }: {
    screen: MemoryScreen;
    /** True while Alicia answers: the source conversation cannot be opened meanwhile. */
    conversationBusy: boolean;
    onOpenConversation: (conversationId: string) => void;
  } = $props();

  const SCOPES: readonly MemoryScope[] = ["personal", "common"];
  const uid = $props.id();

  /** Changes with what the panel shows, so each memory fades in and the forget question closes. */
  const key = $derived(screen.creating ? "new" : (screen.selectedId ?? "none"));
  const origin = $derived(screen.selected === null ? null : provenance(screen.selected));

  /** The panel the forget question was asked on: showing another memory closes it. */
  let askingOn = $state<string | null>(null);
  const askingForget = $derived(askingOn !== null && askingOn === key);
  let forgetting = $state(false);
  let keepButton = $state<HTMLButtonElement | null>(null);
  let forgetButton = $state<HTMLButtonElement | null>(null);
  let returnFocus = false;

  // The safe answer gets the focus when the question shows up; "Oublier" gets it back afterwards.
  $effect(() => {
    if (askingForget) {
      keepButton?.focus();
    } else if (returnFocus && forgetButton !== null) {
      returnFocus = false;
      forgetButton.focus();
    }
  });

  function handleText(event: Event & { currentTarget: HTMLTextAreaElement }): void {
    if (screen.draft !== null) screen.draft.text = event.currentTarget.value;
  }

  function handleKind(event: Event & { currentTarget: HTMLSelectElement }): void {
    const kind = MEMORY_KINDS.find((k) => k === event.currentTarget.value);
    if (kind !== undefined && screen.draft !== null) screen.draft.kind = kind;
  }

  function setScope(scope: MemoryScope): void {
    if (screen.draft !== null) screen.draft.scope = scope;
  }

  function togglePin(): void {
    if (screen.draft !== null) screen.draft.pinned = !screen.draft.pinned;
  }

  /** Ctrl + Entrée in the text saves. */
  function handleTextKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && event.ctrlKey && !event.isComposing) {
      event.preventDefault();
      void save();
    }
  }

  function cancelCreate(): void {
    screen.creating = false;
    screen.draft = null;
    screen.error = null;
  }

  function askForget(): void {
    askingOn = key;
  }

  function keep(): void {
    returnFocus = true;
    askingOn = null;
  }

  /** The next card when the shown memory leaves the list (forgotten, or moved out of this tab). */
  function nextAfter(id: string): string | null {
    return neighbourId(screen.visible.map((m) => m.id), id);
  }

  /** Saves; when the memory moved out of this tab, the focus goes to the next card. */
  async function save(): Promise<void> {
    const id = screen.creating ? null : screen.selectedId;
    const listed = id !== null && screen.items.some((m) => m.id === id);
    const next = id === null ? null : nextAfter(id);
    await screen.save();
    if (listed && !screen.items.some((m) => m.id === id)) await focusMemory(next);
  }

  /** Arrow keys move the choice between Moi and Famille (one tab stop for the group). */
  function handleScopeKeydown(event: KeyboardEvent & { currentTarget: HTMLElement }): void {
    if (screen.draft === null) return;
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = SCOPES.indexOf(screen.draft.scope);
    const scope = SCOPES[(index + step + SCOPES.length) % SCOPES.length];
    if (scope === undefined) return;
    setScope(scope);
    // Looked up next to the key pressed: while the sheet fades between memories, two of them exist.
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-testid="memory-scope-${scope}"]`)?.focus();
  }

  async function confirmForget(): Promise<void> {
    if (forgetting) return;
    forgetting = true;
    const id = screen.selectedId;
    const next = id === null ? null : nextAfter(id);
    await screen.forget();
    if (id !== null && !screen.items.some((m) => m.id === id)) await focusMemory(next);
    else returnFocus = true;
    forgetting = false;
    askingOn = null;
  }

  function handleForgetKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    keep();
  }
</script>

<div class="panes">
  {#key key}
    <div class="pane" transition:fade={{ duration: motion(160) }}>
      {#if screen.draft !== null}
        {@const draft = screen.draft}
        <form class="sheet" onsubmit={(event) => { event.preventDefault(); void save(); }} data-testid="memory-detail">
          <h3>{screen.creating ? "Nouveau souvenir" : "Le souvenir"}</h3>
          <textarea
            value={draft.text}
            oninput={handleText}
            onkeydown={handleTextKeydown}
            rows="4"
            maxlength="1000"
            placeholder="Ce qu'Alicia doit retenir…"
            aria-label="Texte du souvenir"
            data-testid="memory-text"
          ></textarea>
          <div class="row">
            <div class="segment" role="radiogroup" aria-label="Pour qui">
              {#each SCOPES as scope (scope)}
                <button
                  type="button"
                  role="radio"
                  tabindex={draft.scope === scope ? 0 : -1}
                  onkeydown={handleScopeKeydown}
                  class:on={draft.scope === scope}
                  aria-checked={draft.scope === scope}
                  onclick={() => { setScope(scope); }}
                  data-testid="memory-scope-{scope}"
                >{SCOPE_LABEL[scope]}</button>
              {/each}
            </div>
            <select value={draft.kind} onchange={handleKind} aria-label="Type" data-testid="memory-kind">
              {#each MEMORY_KINDS as kind (kind)}
                <option value={kind}>{KIND_LABEL[kind]}</option>
              {/each}
            </select>
            <button
              type="button"
              class="pin"
              class:on={draft.pinned}
              role="switch"
              aria-checked={draft.pinned}
              title="Alicia garde un souvenir épinglé toujours en tête."
              onclick={togglePin}
              data-testid="memory-pin"
            >
              <span aria-hidden="true">📌</span>Épinglé<span class="switch" aria-hidden="true"><span class="knob"></span></span>
            </button>
          </div>
          {#if screen.selected !== null && origin !== null}
            <div class="facts">
              <p data-testid="memory-provenance">
                {#if origin.conversation !== null}
                  {@const conversation = origin.conversation}
                  {origin.text} <button
                    type="button"
                    class="link"
                    onclick={() => { if (!conversationBusy) onOpenConversation(conversation.id); }}
                    aria-disabled={conversationBusy}
                    aria-describedby={conversationBusy ? `${uid}-provenance-wait` : undefined}
                    title={conversationBusy ? "Disponible après la réponse d'Alicia" : conversation.title}
                    data-testid="memory-provenance-link"
                  >“{conversation.title}”</button>
                  {#if conversationBusy}<span id="{uid}-provenance-wait" class="visually-hidden">Disponible après la réponse d'Alicia</span>{/if}
                {:else}
                  {origin.text}
                {/if}
              </p>
              <p data-testid="memory-usage">{usage(screen.selected)}</p>
            </div>
          {/if}
          {#if screen.error !== null}
            <p class="error" role="alert" data-testid="memory-error" transition:fade={{ duration: motion(150) }}>{screen.error}</p>
          {/if}
          <div class="actions">
            {#if askingForget}
              <div class="ask" role="group" aria-labelledby="{uid}-forget" in:fade={{ duration: motion(150) }}>
                <span id="{uid}-forget" class="question">Oublier ce souvenir ? Il reste 30 jours dans la corbeille.</span>
                <button type="button" class="yes" onclick={() => void confirmForget()} onkeydown={handleForgetKeydown} disabled={forgetting} data-testid="memory-forget-yes">Oui</button>
                <button type="button" class="no" bind:this={keepButton} onclick={keep} onkeydown={handleForgetKeydown} disabled={forgetting} data-testid="memory-forget-no">Non</button>
              </div>
            {:else}
              <button type="submit" class="save" disabled={!screen.dirty || screen.saving} data-testid="memory-save">
                {screen.saving ? "Enregistrement…" : "Enregistrer"}
              </button>
              {#if screen.creating}
                <button type="button" class="secondary" onclick={cancelCreate} data-testid="memory-cancel">Annuler</button>
              {:else}
                <button type="button" class="secondary" bind:this={forgetButton} onclick={askForget} data-testid="memory-forget">Oublier</button>
              {/if}
            {/if}
          </div>
        </form>
      {:else}
        <div class="help" data-testid="memory-help">
          {#if screen.tab === "trash"}
            <p>Les souvenirs oubliés restent ici 30 jours.</p>
            <p class="muted">« Récupérer » remet un souvenir à sa place, tel qu'il était.</p>
          {:else}
            <p>Choisis un souvenir, ou teste une question.</p>
            <p class="muted">« Tester comme question » montre ce qu'Alicia retrouverait, dans l'ordre, et pourquoi.</p>
          {/if}
          {#if screen.error !== null}
            <p class="error" role="alert" data-testid="memory-error" transition:fade={{ duration: motion(150) }}>{screen.error}</p>
          {/if}
        </div>
      {/if}
    </div>
  {/key}
</div>

<style>
  .panes { flex: 1; min-height: 0; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); }
  .pane { grid-area: 1 / 1; min-height: 0; overflow-y: auto; padding: 14px 18px 18px; }
  .sheet { display: flex; flex-direction: column; gap: 12px; }
  h3 { margin: 0; font-size: 14px; color: var(--sage); }
  textarea {
    width: 100%; resize: vertical; min-height: 96px; background: var(--surface); border: 1px solid transparent; border-radius: 10px;
    padding: 8px 10px; line-height: 1.45; outline: none; transition: border-color var(--duration) ease;
  }
  textarea:focus { border-color: var(--surface-raised); }
  textarea::placeholder { color: var(--muted); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button { border: 0; background: none; cursor: pointer; border-radius: 9px; transition: background var(--duration) ease, color var(--duration) ease, border-color var(--duration) ease, opacity var(--duration) ease; }
  button:disabled { cursor: default; opacity: 0.45; }
  .segment { display: flex; background: var(--surface); border-radius: 9px; padding: 2px; }
  .segment button { padding: 3px 12px; border-radius: 7px; font-size: 13px; color: var(--cream-muted); }
  .segment button:hover { color: var(--cream); }
  .segment button.on { background: var(--surface-raised); color: var(--cream); font-weight: 700; }
  select {
    background: var(--surface); color: var(--cream); border: 0; border-radius: 9px;
    padding: 5px 8px; font: inherit; font-size: 13px; cursor: pointer;
  }
  /* Same switch as « Réfléchir » in the composer. */
  .pin {
    display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--cream-muted);
    background: var(--night); border: 1px solid var(--surface-raised); border-radius: 999px; padding: 4px 8px 4px 10px;
  }
  .pin:hover { border-color: var(--muted); }
  .pin.on { color: var(--amber); border-color: var(--amber); }
  .switch {
    position: relative; width: 24px; height: 14px; border-radius: 999px; margin-left: 2px;
    background: var(--surface-raised); transition: background var(--duration) ease;
  }
  .knob {
    position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%;
    background: var(--cream-muted); transition: transform var(--duration) ease, background var(--duration) ease;
  }
  .pin.on .switch { background: color-mix(in srgb, var(--amber) 45%, transparent); }
  .pin.on .knob { transform: translateX(10px); background: var(--amber); }
  .facts { display: flex; flex-direction: column; gap: 3px; font-size: 13px; color: var(--muted); }
  .facts p { margin: 0; }
  /* A long title is cut with an ellipsis (the whole title is in the tooltip). */
  .link {
    display: inline-block; max-width: 100%; vertical-align: bottom; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 0; border-radius: 4px; color: var(--sage); text-decoration: underline; text-underline-offset: 2px; font-size: inherit;
  }
  .link:hover:not([aria-disabled="true"]) { color: var(--cream); }
  .link[aria-disabled="true"] { cursor: default; opacity: 0.45; }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .error { margin: 0; padding: 6px 10px; border-radius: 8px; background: var(--surface); color: var(--amber); font-size: 13px; }
  .actions { display: flex; gap: 8px; align-items: center; min-height: 34px; }
  .save { background: var(--sage); color: var(--night); font-weight: 700; padding: 7px 14px; }
  .secondary { color: var(--cream-muted); border: 1px solid var(--surface-raised); padding: 6px 12px; }
  .secondary:hover { border-color: var(--amber); color: var(--amber); }
  .ask { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; }
  .question { color: var(--cream); font-weight: 700; margin-right: 4px; }
  .ask button { padding: 5px 12px; }
  .yes { background: var(--surface-raised); color: var(--amber); font-weight: 700; }
  .yes:hover:not(:disabled) { background: var(--surface); }
  .no { color: var(--cream-muted); }
  .no:hover:not(:disabled) { background: var(--surface); }
  .help { margin-top: 24px; text-align: center; color: var(--cream-muted); display: flex; flex-direction: column; gap: 4px; align-items: center; }
  .help p { margin: 0; max-width: 360px; }
  .help .muted { color: var(--muted); font-size: 13px; }
  .help .error { margin-top: 10px; }
</style>
