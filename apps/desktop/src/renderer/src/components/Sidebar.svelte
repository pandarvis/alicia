<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, type TransitionConfig } from "svelte/transition";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";
  import { motion } from "../lib/motion.ts";

  let { store, personName, onSignOut }: {
    store: ChatStore;
    personName: string;
    onSignOut: () => void;
  } = $props();

  const uid = $props.id();
  let confirming = $state(false);
  let signOutButton = $state<HTMLButtonElement | null>(null);
  let cancelButton = $state<HTMLButtonElement | null>(null);
  /** Set when the question is dismissed, so the focus goes back to "Déconnecter". */
  let returnFocus = false;

  /** Opens and closes by width, so the chat area beside it glides instead of jumping. */
  function reveal(node: Element): TransitionConfig {
    const width = node.getBoundingClientRect().width;
    return {
      duration: motion(200),
      easing: cubicOut,
      css: (t) => `width: ${t * width}px; opacity: ${t}`,
    };
  }

  function startNew(): void {
    store.startNew();
  }

  function askSignOut(): void {
    confirming = true;
  }

  function cancelSignOut(): void {
    returnFocus = true;
    confirming = false;
  }

  function confirmSignOut(): void {
    onSignOut();
  }

  function handleConfirmKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancelSignOut();
  }

  // The safe answer gets the focus when the question shows up; "Déconnecter" gets it back afterwards.
  $effect(() => {
    if (confirming) {
      cancelButton?.focus();
    } else if (returnFocus && signOutButton !== null) {
      returnFocus = false;
      signOutButton.focus();
    }
  });
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
      {#if confirming}
        <div class="confirm" role="group" aria-labelledby="{uid}-question" aria-describedby="{uid}-hint" data-testid="sign-out-confirm" in:fade={{ duration: motion(150) }}>
          <p id="{uid}-question" class="question">Déconnecter cet appareil ?</p>
          <p id="{uid}-hint" class="hint">Il faudra l'appairer à nouveau.</p>
          <div class="actions">
            <button class="yes" onclick={confirmSignOut} onkeydown={handleConfirmKeydown} data-testid="sign-out-yes">Oui</button>
            <button class="no" bind:this={cancelButton} onclick={cancelSignOut} onkeydown={handleConfirmKeydown} data-testid="sign-out-cancel">Annuler</button>
          </div>
        </div>
      {:else}
        <div class="who" in:fade={{ duration: motion(150) }}>
          <span>{personName}</span>
          <button class="link" bind:this={signOutButton} onclick={askSignOut} data-testid="sign-out">Déconnecter</button>
        </div>
      {/if}
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
  footer { padding: 8px 10px 0; font-size: 13px; color: var(--cream-muted); }
  .who { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link { color: var(--muted); font-size: 12px; padding: 2px 4px; flex: none; }
  .link:hover { color: var(--amber); }
  .confirm { display: flex; flex-direction: column; gap: 2px; }
  .question { margin: 0; color: var(--cream); font-weight: 700; }
  .hint { margin: 0; color: var(--muted); font-size: 12px; }
  .actions { display: flex; gap: 6px; margin-top: 6px; }
  .actions button { padding: 4px 12px; font-size: 13px; }
  .yes { background: var(--surface-raised); color: var(--amber); font-weight: 700; }
  .yes:hover { background: var(--surface); }
  .no { color: var(--cream-muted); }
  .no:hover { background: var(--surface); }
</style>
