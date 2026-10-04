<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";
  import Mascot from "./Mascot.svelte";

  let { store, personName }: { store: ChatStore; personName: string } = $props();

  const SUGGESTIONS = [
    "Raconte-moi une anecdote surprenante",
    "Aide-moi à formuler un message gentil",
    "Réfléchis bien : une idée de sortie ce week-end ?",
  ];

  const greeting = (): string => {
    const hour = new Date().getHours();
    return hour >= 5 && hour < 18 ? "Bonjour" : "Bonsoir";
  };

  let list = $state<HTMLDivElement | null>(null);
  const lastAssistantId = $derived(store.messages.findLast((m) => m.role === "assistant")?.id);
  const waiting = $derived(store.busy && store.messages.at(-1)?.role === "user");

  /** Changes whenever a message is added or streams more text. */
  const progress = $derived(`${store.messages.length}:${store.messages.at(-1)?.text.length ?? 0}`);
  let followedProgress = "";

  // Follow the conversation as text streams in.
  $effect(() => {
    if (list === null || progress === followedProgress) return;
    followedProgress = progress;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  });
</script>

<section class="chat">
  {#if store.messages.length === 0 && store.loading}
    <div class="center" in:fade={{ duration: 200 }} data-testid="chat-loading">
      <Mascot mood="thinking" size={120} />
      <p class="loading">Chargement…</p>
    </div>
  {:else if store.messages.length === 0}
    <div class="center" in:fade={{ duration: 200 }} data-testid="chat-welcome">
      <Mascot mood={store.mascot} size={180} />
      <h1>{greeting()} {personName}, on fait quoi ?</h1>
      <div class="suggestions">
        {#each SUGGESTIONS as suggestion (suggestion)}
          <button onclick={() => { store.send(suggestion); }} disabled={store.busy || store.loading}>{suggestion}</button>
        {/each}
      </div>
    </div>
  {:else}
    <div class="messages" bind:this={list} data-testid="messages" in:fade={{ duration: 200 }}>
      {#each store.messages as message (message.id)}
        <div class="row {message.role}" in:fly={{ y: 8, duration: 180 }}>
          {#if message.role === "assistant"}
            <div class="avatar">
              <!-- Only one mascot at a time: it moves to the typing row while Alicia thinks about the next answer. -->
              {#if message.id === lastAssistantId && !waiting}
                <div transition:fade={{ duration: 150 }}><Mascot mood={store.mascot} size={44} /></div>
              {/if}
            </div>
          {/if}
          <div class="bubble" data-testid="message-{message.role}">
            {message.text}{#if message.streaming}<span class="caret"></span>{/if}
          </div>
        </div>
      {/each}
      {#if waiting}
        <div class="row assistant" in:fade={{ duration: 150 }}>
          <div class="avatar"><Mascot mood={store.mascot} size={44} /></div>
          <div class="bubble typing" role="status" aria-label="Alicia réfléchit"><span></span><span></span><span></span></div>
        </div>
      {/if}
      {#if store.activity}<p class="activity" transition:fade={{ duration: 150 }}>{store.activity}</p>{/if}
    </div>
  {/if}
  {#if store.notice}
    <p class="notice" role="status" data-testid="notice" transition:fade={{ duration: 150 }}>{store.notice}</p>
  {/if}
</section>

<style>
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .center { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; }
  h1 { margin: 0; font-size: 24px; text-align: center; }
  .loading { margin: 0; color: var(--muted); }
  .suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 640px; }
  .suggestions button {
    background: none; border: 1px solid var(--surface-raised); border-radius: 16px; padding: 6px 12px;
    color: var(--cream-muted); cursor: pointer; transition: border-color var(--duration) ease, color var(--duration) ease;
  }
  .suggestions button:hover:not(:disabled) { border-color: var(--sage); color: var(--cream); }
  .suggestions button:disabled { opacity: 0.6; cursor: default; }
  .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 20px max(24px, calc((100% - 760px) / 2)); display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  .row.user { justify-content: flex-end; }
  .avatar { width: 44px; flex: none; }
  .bubble { max-width: 72%; padding: 9px 13px; border-radius: 14px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .user .bubble { background: var(--surface-raised); border-bottom-right-radius: 4px; }
  .assistant .bubble { background: var(--surface); border-bottom-left-radius: 4px; }
  .caret { display: inline-block; width: 7px; height: 1em; margin-left: 2px; vertical-align: -2px; background: var(--sage); animation: blink 1s steps(2) infinite; }
  .typing { display: flex; gap: 4px; padding: 14px 16px; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--cream-muted); animation: bounce 1.2s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }
  .activity { margin: 0 0 0 52px; font-size: 13px; color: var(--muted); font-style: italic; }
  .notice { margin: 0 auto 8px; padding: 6px 12px; border-radius: 8px; background: var(--night-deep); color: var(--amber); font-size: 14px; }
  @keyframes blink { 50% { opacity: 0; } }
  @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }
</style>
