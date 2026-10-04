<script lang="ts">
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import type { MiniChat } from "../lib/mini-chat.svelte.ts";
  import { motion, scrollBehavior } from "../lib/motion.ts";

  let { chat, onClose }: { chat: MiniChat; onClose: () => void } = $props();

  let text = $state("");
  let input = $state<HTMLTextAreaElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  const store = $derived(chat.store);
  const ready = $derived(chat.status === "ready");
  /** Changes whenever a message is added or grows: the list then follows its end. */
  const tail = $derived(`${store.messages.length}:${store.messages.at(-1)?.text.length ?? 0}`);
  let seenTail = "";

  onMount(() => {
    input?.focus();
  });

  $effect(() => {
    if (list === null || tail === seenTail) return;
    seenTail = tail;
    list.scrollTo({ top: list.scrollHeight, behavior: scrollBehavior() });
  });

  function submit(): void {
    if (store.send(text)) text = "";
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  function openInApp(): void {
    const id = store.activeId;
    if (id === null) void window.alicia.app.showMain();
    else void window.alicia.app.openConversation(id);
  }
</script>

<section class="chat" aria-label="Discussion avec Alicia" data-testid="holo-chat">
  <header>
    <span class="title">Alicia</span>
    <button class="icon" onclick={() => { store.startNew(); }} disabled={store.busy} title="Nouvelle conversation" aria-label="Nouvelle conversation" data-testid="holo-chat-new"><Plus size={15} aria-hidden="true" /></button>
    <button class="icon" onclick={openInApp} title="Ouvrir dans l'app" aria-label="Ouvrir dans l'app" data-testid="holo-chat-open"><ExternalLink size={15} aria-hidden="true" /></button>
    <button class="icon" onclick={onClose} title="Fermer" aria-label="Fermer la discussion" data-testid="holo-chat-close"><X size={15} aria-hidden="true" /></button>
  </header>
  <div class="messages" bind:this={list}>
    {#each store.messages as message (message.id)}
      <p class="bubble {message.role}" data-testid="holo-message-{message.role}" in:fade={{ duration: motion(150) }}>
        {message.text}{#if message.streaming}<span class="caret"></span>{/if}
      </p>
    {:else}
      <p class="empty" in:fade={{ duration: motion(150) }}>Une question rapide ? Je t'écoute.</p>
    {/each}
    {#if store.activity}<p class="activity" transition:fade={{ duration: motion(150) }}>{store.activity}</p>{/if}
  </div>
  {#if store.notice}<p class="notice" role="status" transition:fade={{ duration: motion(150) }}>{store.notice}</p>{/if}
  <textarea
    bind:this={input}
    bind:value={text}
    onkeydown={handleKeydown}
    oninput={() => { window.alicia.presence.typing(); }}
    rows="2"
    placeholder={ready ? "Écris à Alicia…" : "Connexion à Alicia…"}
    aria-label="Message pour Alicia"
    disabled={!ready}
    data-testid="holo-input"
  ></textarea>
</section>

<style>
  .chat {
    height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 12px;
    background: var(--night-deep); border: 1px solid var(--surface); border-radius: 18px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
  }
  header { display: flex; align-items: center; gap: 2px; }
  .title { flex: 1; font-weight: 700; color: var(--cream); }
  .icon { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: none; color: var(--cream-muted); cursor: pointer; transition: background var(--duration) ease, color var(--duration) ease; }
  .icon:hover:not(:disabled) { background: var(--surface); color: var(--cream); }
  .icon:disabled { opacity: 0.5; cursor: default; }
  .messages { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .bubble { margin: 0; padding: 7px 10px; border-radius: 12px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; max-width: 92%; }
  .bubble.user { align-self: flex-end; background: var(--surface-raised); }
  .bubble.assistant { align-self: flex-start; background: var(--surface); }
  .caret { display: inline-block; width: 6px; height: 1em; margin-left: 2px; vertical-align: -2px; background: var(--sage); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .empty, .activity { margin: auto 0 0; color: var(--muted); font-size: 13px; }
  .notice { margin: 0; color: var(--amber); font-size: 13px; }
  textarea { resize: none; border: 1px solid transparent; border-radius: 10px; padding: 8px 10px; background: var(--surface); transition: border-color var(--duration) ease; }
  textarea:focus { outline: none; border-color: var(--sage); }
</style>
