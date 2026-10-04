<script lang="ts">
  import { untrack } from "svelte";
  import type { ConnectionStatus } from "../lib/chat-connection.ts";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";

  let { store, status }: { store: ChatStore; status: ConnectionStatus } = $props();
  let text = $state("");
  const ready = $derived(status === "ready");
  const canSend = $derived(ready && !store.busy && !store.loading && text.trim() !== "");
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let previousStatus = untrack(() => status);

  // Back online after a drop: give the focus back to the composer, unless the user is elsewhere.
  $effect(() => {
    const reconnected = previousStatus === "offline" && status === "ready";
    previousStatus = status;
    if (!reconnected || textarea === null || !document.hasFocus()) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body || focused === textarea) textarea.focus();
  });

  function submit(): void {
    if (store.send(text)) text = "";
  }

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    submit();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function toggleOpus(): void {
    store.opus = !store.opus;
  }
</script>

<form class="composer" onsubmit={handleSubmit}>
  <textarea
    bind:value={text}
    bind:this={textarea}
    onkeydown={handleKeydown}
    rows="1"
    placeholder={ready ? "Demande à Alicia…" : "Connexion à Alicia…"}
    aria-label="Message pour Alicia"
    disabled={!ready}
    data-testid="composer-input"
  ></textarea>
  <button
    type="button"
    class="opus"
    class:on={store.opus}
    aria-pressed={store.opus}
    title="Réfléchir plus longtemps (Opus)"
    onclick={toggleOpus}
    data-testid="composer-opus"
  >Opus</button>
  <button type="submit" class="send" disabled={!canSend} data-testid="composer-send">
    Envoyer
  </button>
</form>

<style>
  .composer {
    margin: 0 max(24px, calc((100% - 760px) / 2)) 18px; display: flex; align-items: flex-end; gap: 8px;
    background: var(--surface); border-radius: 14px; padding: 8px; flex: none;
    box-shadow: 0 0 0 1px transparent; transition: box-shadow var(--duration) ease;
  }
  /* The textarea has no outline of its own: the whole composer shows the focus. */
  .composer:focus-within { box-shadow: 0 0 0 1px var(--surface-raised); }
  textarea {
    flex: 1; resize: none; border: 0; background: none; padding: 6px 8px; line-height: 1.45;
    field-sizing: content; max-height: 200px; outline: none;
  }
  textarea:disabled { opacity: 0.6; }
  button { border: 0; border-radius: 9px; padding: 7px 12px; cursor: pointer; transition: background var(--duration) ease, color var(--duration) ease, opacity var(--duration) ease; }
  .opus { background: none; color: var(--muted); font-size: 13px; }
  .opus:hover { color: var(--cream-muted); }
  .opus.on { background: var(--surface-raised); color: var(--amber); font-weight: 700; }
  .send { background: var(--sage); color: var(--night); font-weight: 700; }
  .send:disabled { opacity: 0.45; cursor: default; }
</style>
