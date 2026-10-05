<script lang="ts">
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import { untrack } from "svelte";
  import { fade, slide } from "svelte/transition";
  import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
  import { ACCEPTED_FILES } from "../lib/attachment-labels.ts";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";
  import { motion } from "../lib/motion.ts";
  import { throttle, TYPING_INTERVAL_MS } from "../lib/throttle.ts";
  import AttachmentChips from "./AttachmentChips.svelte";

  let { store, status, focusRequests = 0 }: {
    store: ChatStore;
    status: ConnectionStatus;
    /** Each increase puts the cursor in the message field (a card was answered: its pressed button turned off). */
    focusRequests?: number;
  } = $props();
  let text = $state("");
  const ready = $derived(status === "ready");
  const canSend = $derived(ready && store.canSend(text));
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  /** Drag enter/leave pairs still open over the window: the drop hint shows while it is above 0. */
  let dragDepth = $state(0);
  let previousStatus = untrack(() => status);
  /** Typing is reported a few times a second at most, not on every key. */
  const typing = throttle(() => { window.alicia.presence.typing(); }, TYPING_INTERVAL_MS);

  // Back online after a drop: give the focus back to the composer, unless the user is elsewhere.
  $effect(() => {
    const reconnected = previousStatus === "offline" && status === "ready";
    previousStatus = status;
    if (!reconnected || textarea === null || !document.hasFocus()) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body || focused === textarea) textarea.focus();
  });

  let seenFocusRequests = untrack(() => focusRequests);
  $effect(() => {
    if (focusRequests === seenFocusRequests) return;
    seenFocusRequests = focusRequests;
    textarea?.focus();
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

  /** Files go to the composer only while Alicia is reachable (an upload would fail otherwise). */
  function attach(files: readonly File[]): void {
    if (files.length === 0) return;
    if (!ready) {
      store.notice = "Alicia n'est pas joignable pour l'instant : joins le fichier une fois reconnecté.";
      return;
    }
    store.addFiles(files);
  }

  const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") ?? false;

  // Files may be dropped anywhere on the window; the window must never open them itself.
  function handleDragenter(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth++;
  }

  function handleDragover(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragleave(event: DragEvent): void {
    if (carriesFiles(event)) dragDepth = Math.max(0, dragDepth - 1);
  }

  function handleDrop(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    attach([...(event.dataTransfer?.files ?? [])]);
  }

  /** A pasted file (a screenshot, a file copied in the explorer) is attached; pasted text stays a normal paste. */
  function handlePaste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    attach(files);
  }

  function handlePick(): void {
    const files = [...(picker?.files ?? [])];
    // Emptied, so that picking the same file again still counts as a change.
    if (picker !== null) picker.value = "";
    attach(files);
  }
</script>

<svelte:window ondragenter={handleDragenter} ondragover={handleDragover} ondragleave={handleDragleave} ondrop={handleDrop} />

<form class="composer" class:dragging={dragDepth > 0} onsubmit={handleSubmit} data-testid="composer">
  {#if store.drafts.length > 0}
    <div transition:slide={{ duration: motion(160) }}>
      <AttachmentChips drafts={store.drafts} onremove={(localId: string) => { store.removeDraft(localId); }} />
    </div>
  {/if}
  <div class="row">
    <button
      type="button"
      class="attach"
      title="Joindre un fichier (tu peux aussi le glisser ici ou le coller)"
      aria-label="Joindre un fichier"
      disabled={!ready}
      onclick={() => { picker?.click(); }}
      data-testid="composer-attach"
    ><Paperclip size={16} aria-hidden="true" /></button>
    <input bind:this={picker} type="file" multiple accept={ACCEPTED_FILES} hidden onchange={handlePick} data-testid="composer-file" />
    <textarea
      bind:value={text}
      bind:this={textarea}
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      oninput={typing}
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
      <Sparkles class="spark" size={14} aria-hidden="true" />Réfléchir<span class="switch" aria-hidden="true"><span class="knob"></span></span>
    </button>
    <button type="submit" class="send" disabled={!canSend} data-testid="composer-send">
      Envoyer
    </button>
  </div>
  {#if dragDepth > 0}
    <p class="drop-hint" transition:fade={{ duration: motion(120) }}>Lâche le fichier pour le joindre à ton message</p>
  {/if}
</form>

<style>
  .composer {
    margin: 0 max(24px, calc((100% - 760px) / 2)) 18px; display: flex; flex-direction: column; gap: 6px;
    background: var(--surface); border-radius: 14px; padding: 8px; flex: none;
    box-shadow: 0 0 0 1px transparent; transition: box-shadow var(--duration) ease;
  }
  .row { display: flex; align-items: flex-end; gap: 8px; }
  /* The textarea has no outline of its own: the whole composer shows the focus. */
  .composer:focus-within { box-shadow: 0 0 0 1px var(--surface-raised); }
  .composer.dragging { box-shadow: 0 0 0 2px var(--sage); }
  .attach { background: none; color: var(--cream-muted); padding: 7px; display: flex; }
  .attach:hover:not(:disabled) { color: var(--cream); background: var(--night-deep); }
  .attach:disabled { opacity: 0.45; cursor: default; }
  .drop-hint { margin: 0; text-align: center; font-size: 13px; color: var(--sage); }
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
