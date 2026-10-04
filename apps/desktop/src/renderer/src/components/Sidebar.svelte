<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, slide, type TransitionConfig } from "svelte/transition";
  import type { AppView } from "../lib/app-view.ts";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";
  import { motion } from "../lib/motion.ts";

  let { store, personName, view, onView, onSignOut }: {
    store: ChatStore;
    personName: string;
    view: AppView;
    onView: (view: AppView) => void;
    onSignOut: () => void;
  } = $props();

  const uid = $props.id();
  let confirming = $state(false);
  let signOutButton = $state<HTMLButtonElement | null>(null);
  let cancelButton = $state<HTMLButtonElement | null>(null);
  /** Set when the question is dismissed, so the focus goes back to "Déconnecter". */
  let returnFocus = false;

  /** The conversation whose deletion is being asked, and whether the brain is deleting it. */
  let deletingId = $state<string | null>(null);
  let deleting = $state(false);
  let list = $state<HTMLUListElement | null>(null);
  let newButton = $state<HTMLButtonElement | null>(null);
  let keepButton = $state<HTMLButtonElement | null>(null);
  /** Why a deletion did not happen, shown in its row for a moment (the chat notice may not be on screen). */
  let refusal = $state<{ id: string; text: string } | null>(null);
  const REFUSAL_MS = 5000;
  const REFUSALS = {
    busy: "Alicia répond ici : réessaie après sa réponse.",
    failed: "Impossible de supprimer pour l'instant.",
  } as const;

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
    onView("chat");
    store.startNew();
  }

  function open(conversationId: string): void {
    onView("chat");
    void store.open(conversationId);
  }

  function askDelete(conversationId: string): void {
    refusal = null;
    deletingId = conversationId;
  }

  /** Closes the question and gives the focus back to the row's 🗑. */
  function keep(): void {
    const id = deletingId;
    deletingId = null;
    if (id === null) return;
    requestAnimationFrame(() => {
      list?.querySelector<HTMLButtonElement>(`button[data-conversation-id="${CSS.escape(id)}"]`)?.focus();
    });
  }

  async function confirmDelete(): Promise<void> {
    const id = deletingId;
    if (id === null || deleting) return;
    deleting = true;
    refusal = null;
    const result = await store.removeConversation(id);
    deleting = false;
    if (result === "deleted" || result === "not_found") {
      deletingId = null;
      newButton?.focus();
    } else {
      refusal = { id, text: REFUSALS[result] };
      keep();
    }
  }

  $effect(() => {
    if (refusal === null) return;
    const timer = setTimeout(() => {
      refusal = null;
    }, REFUSAL_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  function handleDeleteKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    keep();
  }

  // The safe answer gets the focus when the deletion is asked.
  $effect(() => {
    if (deletingId !== null) keepButton?.focus();
  });

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
    <div class="views">
      <button
        class="view"
        class:active={view === "chat"}
        aria-current={view === "chat" ? "page" : undefined}
        onclick={() => { onView("chat"); }}
        data-testid="nav-chat"
      >✦ Alicia</button>
      <button
        class="view"
        class:active={view === "memories"}
        aria-current={view === "memories" ? "page" : undefined}
        onclick={() => { onView("memories"); }}
        data-testid="nav-memories"
      >🧠 Souvenirs</button>
    </div>
    <button class="new" bind:this={newButton} onclick={startNew} disabled={store.busy} data-testid="new-conversation">
      ✦ Nouvelle conversation
    </button>
    <p class="label">Conversations</p>
    <ul bind:this={list} data-testid="conversation-list">
      {#each store.conversations as conversation (conversation.id)}
        <li class:active={view === "chat" && conversation.id === store.activeId} out:slide={{ duration: motion(180) }}>
          <div class="line">
            {#if deletingId === conversation.id}
              <div class="ask" role="group" aria-label="Supprimer la conversation « {conversation.title} » ?" in:fade={{ duration: motion(150) }}>
                <span class="question">Supprimer ?</span>
                <button class="yes" onclick={() => void confirmDelete()} onkeydown={handleDeleteKeydown} disabled={store.busy || deleting} data-testid="delete-conversation-yes">Oui</button>
                <button class="no" bind:this={keepButton} onclick={keep} onkeydown={handleDeleteKeydown} disabled={deleting} data-testid="delete-conversation-no">Non</button>
              </div>
            {:else}
              <button
                class="open"
                onclick={() => { open(conversation.id); }}
                disabled={store.busy}
                title={conversation.title}
                aria-current={view === "chat" && conversation.id === store.activeId ? "true" : undefined}
              >{conversation.title}</button>
              <button
                class="delete"
                onclick={() => { askDelete(conversation.id); }}
                disabled={store.busy}
                title="Supprimer"
                aria-label="Supprimer la conversation « {conversation.title} »"
                aria-describedby={refusal?.id === conversation.id ? `${uid}-refusal` : undefined}
                data-conversation-id={conversation.id}
                data-testid="delete-conversation"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 1.8h7a2 2 0 0 0 2-1.8l1-12M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" />
                </svg>
              </button>
            {/if}
          </div>
          {#if refusal?.id === conversation.id}
            <p id="{uid}-refusal" class="refusal" role="status" data-testid="delete-conversation-refusal" transition:slide={{ duration: motion(150) }}>{refusal.text}</p>
          {/if}
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
  button { background: none; border: 0; text-align: left; cursor: pointer; border-radius: 8px; transition: background var(--duration) ease, color var(--duration) ease, opacity var(--duration) ease; }
  button:disabled { cursor: default; opacity: 0.6; }
  .views { display: flex; flex-direction: column; gap: 2px; padding-bottom: 8px; margin-bottom: 4px; border-bottom: 1px solid var(--surface); }
  .view { padding: 7px 10px; color: var(--cream-muted); }
  .view:hover { background: var(--surface); color: var(--cream); }
  .view.active { background: var(--surface); color: var(--cream); font-weight: 700; }
  .new { padding: 8px 10px; font-weight: 700; color: var(--sage); }
  .new:hover:not(:disabled) { background: var(--surface); }
  .label { margin: 12px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 0; }
  li { border-radius: 8px; transition: background var(--duration) ease; }
  .line { position: relative; display: flex; align-items: center; }
  .refusal { margin: 0; padding: 0 10px 6px; font-size: 12px; line-height: 1.35; color: var(--amber); }
  li:not(.empty):hover, li.active { background: var(--surface); }
  .open {
    flex: 1; min-width: 0; padding: 7px 10px; color: var(--cream-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  li.active .open { color: var(--cream); font-weight: 700; }
  /* The trash shows on hover and on keyboard focus; the title then stops short of it. */
  li:hover .open, li:focus-within .open { padding-right: 34px; }
  .delete {
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    display: grid; place-items: center; width: 26px; height: 26px; padding: 0;
    color: var(--muted); opacity: 0; pointer-events: none;
  }
  .delete svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  li:hover .delete:not(:disabled), .delete:focus-visible { opacity: 1; pointer-events: auto; }
  .delete:hover:not(:disabled), .delete:focus-visible { color: var(--amber); background: var(--surface-raised); }
  .ask { flex: 1; display: flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; font-size: 13px; }
  .ask .question { flex: 1; color: var(--cream); font-weight: 700; }
  .ask button { padding: 3px 10px; }
  .empty { padding: 7px 10px; color: var(--muted); font-size: 13px; }
  footer { padding: 8px 10px 0; font-size: 13px; color: var(--cream-muted); }
  .who { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link { color: var(--muted); font-size: 12px; padding: 2px 4px; flex: none; }
  .link:hover { color: var(--amber); }
  .confirm { display: flex; flex-direction: column; gap: 2px; }
  .confirm .question { margin: 0; color: var(--cream); font-weight: 700; }
  .hint { margin: 0; color: var(--muted); font-size: 12px; }
  .actions { display: flex; gap: 6px; margin-top: 6px; }
  .actions button { padding: 4px 12px; font-size: 13px; }
  .yes { background: var(--surface-raised); color: var(--amber); font-weight: 700; }
  .no { color: var(--cream-muted); }
  .actions .yes:hover, .actions .no:hover { background: var(--surface); }
  /* In a row, the background is already --surface. */
  .ask .yes:hover:not(:disabled) { background: var(--night-deep); }
  .ask .no:hover:not(:disabled) { background: var(--surface-raised); }
</style>
