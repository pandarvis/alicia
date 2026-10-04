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
    class="think"
    class:on={store.opus}
    role="switch"
    aria-checked={store.opus}
    title="Pour ce message, Alicia prend plus de temps et réfléchit plus en profondeur (consomme plus de quota)."
    onclick={toggleOpus}
    data-testid="composer-opus"
  >
    <span class="spark" aria-hidden="true">✦</span>Réfléchir<span class="switch" aria-hidden="true"><span class="knob"></span></span>
  </button>
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
  .think {
    display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--cream-muted);
    background: var(--night-deep); border: 1px solid var(--surface-raised); border-radius: 999px; padding: 5px 8px 5px 10px;
  }
  .think:hover { border-color: var(--muted); }
  .think.on { color: var(--amber); border-color: var(--amber); }
  .spark { font-size: 12px; }
  .switch {
    position: relative; width: 24px; height: 14px; border-radius: 999px; margin-left: 2px;
    background: var(--surface-raised); transition: background var(--duration) ease;
  }
  .knob {
    position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%;
    background: var(--cream-muted); transition: transform var(--duration) ease, background var(--duration) ease;
  }
  .think.on .switch { background: color-mix(in srgb, var(--amber) 45%, transparent); }
  .think.on .knob { transform: translateX(10px); background: var(--amber); }
  .send { background: var(--sage); color: var(--night); font-weight: 700; }
  .send:disabled { opacity: 0.45; cursor: default; }
</style>
