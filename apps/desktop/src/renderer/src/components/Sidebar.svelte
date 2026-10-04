<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import type { TransitionConfig } from "svelte/transition";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";

  let { store, personName, onSignOut }: {
    store: ChatStore;
    personName: string;
    onSignOut: () => void;
  } = $props();

  /** Opens and closes by width, so the chat area beside it glides instead of jumping. */
  function reveal(node: Element): TransitionConfig {
    const width = node.getBoundingClientRect().width;
    return {
      duration: 200,
      easing: cubicOut,
      css: (t) => `width: ${t * width}px; opacity: ${t}`,
    };
  }

  function startNew(): void {
    store.startNew();
  }

  function signOut(): void {
    if (window.confirm(`Déconnecter cet appareil d'Alicia ? Il faudra l'appairer à nouveau.`)) onSignOut();
  }
</script>

<nav class="sidebar" transition:reveal>
  <div class="inner">
    <button class="new" onclick={startNew} disabled={store.busy} data-testid="new-conversation">
      ✦ Nouvelle conversation
    </button>
    <p class="label">Conversations</p>
    <ul data-testid="conversation-list">
      {#each store.conversations as conversation (conversation.id)}
        <li>
          <button
            class:active={conversation.id === store.activeId}
            onclick={() => void store.open(conversation.id)}
            disabled={store.busy}
            title={conversation.title}
            aria-current={conversation.id === store.activeId ? "page" : undefined}
          >{conversation.title}</button>
        </li>
      {:else}
        <li class="empty">Aucune conversation pour l'instant.</li>
      {/each}
    </ul>
    <footer>
      <span>{personName}</span>
      <button class="link" onclick={signOut}>Déconnecter</button>
    </footer>
  </div>
</nav>

<style>
  /* The outer box animates its width; the inner one keeps its layout and is clipped meanwhile. */
  .sidebar {
    width: 240px; flex: none; overflow: hidden;
    background: var(--night-deep); border-right: 1px solid var(--surface);
  }
  .inner { width: 240px; height: 100%; display: flex; flex-direction: column; gap: 4px; padding: 12px 8px; }
  button { background: none; border: 0; text-align: left; cursor: pointer; border-radius: 8px; transition: background var(--duration) ease, color var(--duration) ease; }
  button:disabled { cursor: default; opacity: 0.6; }
  .new { padding: 8px 10px; font-weight: 700; color: var(--sage); }
  .new:hover:not(:disabled) { background: var(--surface); }
  .label { margin: 12px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 0; }
  li button {
    width: 100%; padding: 7px 10px; color: var(--cream-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  li button:hover:not(:disabled) { background: var(--surface); }
  li button.active { background: var(--surface); color: var(--cream); font-weight: 700; }
  .empty { padding: 7px 10px; color: var(--muted); font-size: 13px; }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px 0; font-size: 13px; color: var(--cream-muted); }
  footer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link { color: var(--muted); font-size: 12px; padding: 2px 4px; flex: none; }
  .link:hover { color: var(--amber); }
</style>
