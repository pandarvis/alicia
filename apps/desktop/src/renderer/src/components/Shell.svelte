<script lang="ts">
  import ShieldQuestionMark from "@lucide/svelte/icons/shield-question-mark";
  import { onDestroy, onMount, untrack } from "svelte";
  import { fade, slide } from "svelte/transition";
  import type { ServerEvent } from "@alicia/protocol";
  import type { StoredSession } from "../../../shared/session.ts";
  import type { AppView } from "../lib/app-view.ts";
  import { BrainApi, UnauthorizedError } from "../lib/brain-client.ts";
  import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
  import { ChatStore } from "../lib/chat-store.svelte.ts";
  import { HubClient } from "../lib/hub-client.ts";
  import { MemoryScreen } from "../lib/memory-screen.svelte.ts";
  import { motion } from "../lib/motion.ts";
  import ChatView from "./ChatView.svelte";
  import Composer from "./Composer.svelte";
  import MemoryView from "./MemoryView.svelte";
  import SettingsView from "./SettingsView.svelte";
  import Sidebar from "./Sidebar.svelte";
  import TitleBar from "./TitleBar.svelte";

  let { session, onSignOut }: { session: StoredSession; onSignOut: (message: string | null) => void } = $props();

  const REVOKED = "Cet appareil a été déconnecté d'Alicia. Appaire-le à nouveau.";

  function schedule(run: () => void, ms: number): () => void {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  }

  // App.svelte re-creates this component when the session changes ({#key}), so reading it once is intended.
  const initialSession = untrack(() => session);
  const api = new BrainApi(fetch, initialSession);
  let status = $state<ConnectionStatus>("connecting");
  let sidebarOpen = $state(true);
  let view = $state<AppView>("chat");
  /** Set once the connection dropped, until it is ready again (resync, and the label stays "offline" during retries). */
  let wasOffline = $state(false);
  /** What the user sees: retries after a drop still read as offline, not as a fresh "connecting". */
  const shownStatus = $derived<ConnectionStatus>(status === "connecting" && wasOffline ? "offline" : status);

  /** A refused device token means the device was revoked: back to pairing. */
  async function guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof UnauthorizedError) onSignOut(REVOKED);
      throw error;
    }
  }

  const store = new ChatStore({
    listConversations: () => guarded(() => api.listConversations()),
    history: (id) => guarded(() => api.history(id)),
    send: (message) => hub.send(message),
    confirm: (message) => hub.confirm(message),
    deleteConversation: (id) => guarded(() => api.deleteConversation(id)),
    newId: () => crypto.randomUUID(),
    schedule,
  });

  // Its own error messages are in French; a revoked device still signs out first.
  const memories = new MemoryScreen({
    list: (filter) => guarded(() => api.listMemories(filter)),
    create: (input) => guarded(() => api.createMemory(input)),
    update: (id, patch) => guarded(() => api.updateMemory(id, patch)),
    forget: (id) => guarded(() => api.forgetMemory(id)),
    restore: (id) => guarded(() => api.restoreMemory(id)),
    test: (q) => guarded(() => api.testMemory(q)),
    now: () => Date.now(),
  });

  function handleEvent(event: ServerEvent): void {
    store.handle(event);
  }

  function handleStatus(next: ConnectionStatus): void {
    status = next;
    if (next === "offline") {
      wasOffline = true;
      store.connectionLost();
    } else if (next === "ready" && wasOffline) {
      wasOffline = false;
      // The brain may have finished the lost turn, or been down when the list was first fetched.
      if (store.activeId === null) void store.refreshConversations();
      else void store.resync();
    } else if (next === "rejected") {
      onSignOut(REVOKED);
    }
  }

  // The brain connection lives in the main process, shared with the Holo and Spotlight.
  const hub = new HubClient(window.alicia.brain, {
    onEvent: handleEvent,
    onStatus: handleStatus,
    onUndelivered: (requestId) => {
      store.undelivered(requestId);
    },
  });

  const title = $derived(
    view === "memories"
      ? "Souvenirs"
      : view === "settings"
        ? "Réglages"
        : (store.conversations.find((c) => c.id === store.activeId)?.title ?? "Nouvelle conversation"),
  );

  function showView(next: AppView): void {
    view = next;
  }

  /** From a memory, back to the conversation it was remembered in. */
  function openConversation(conversationId: string): void {
    // While Alicia answers, the chat cannot switch conversation: stay here rather than show the wrong one.
    if (store.busy) return;
    view = "chat";
    void store.open(conversationId);
  }

  /** Asks the composer for the focus (see Composer). */
  let composerFocus = $state(0);

  /**
   * Another window's question waits where the person cannot see it: in another conversation, or in this one while
   * Souvenirs or Réglages is shown.
   */
  const awaiting = $derived(store.awaitingElsewhere ?? (view !== "chat" ? store.awaitingAnywhere : null));

  /** Shows that question: back to the chat, on its conversation (opened once this window's answer ended). */
  function showAwaiting(conversationId: string): void {
    view = "chat";
    if (conversationId !== store.activeId) store.openWhenIdle(conversationId);
  }

  function toggleSidebar(): void {
    sidebarOpen = !sidebarOpen;
  }

  function signOut(): void {
    onSignOut(null);
  }

  onMount(() => {
    hub.start();
    void store.refreshConversations();
    const offs = [
      // A notification or the Holo asks for a conversation: shown once this window's own answer has ended.
      window.alicia.app.onOpenConversation((conversationId) => {
        view = "chat";
        store.openWhenIdle(conversationId);
      }),
      // Another window's turn failed after creating its conversation.
      window.alicia.brain.onConversationsChanged(() => {
        void store.refreshConversations();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  });
  onDestroy(() => {
    hub.stop();
  });
</script>

<div class="app">
  <TitleBar {title} personName={session.person.name} status={shownStatus} {sidebarOpen} onToggleSidebar={toggleSidebar} />
  {#if awaiting !== null}
    {@const where = awaiting}
    {@const here = where === store.activeId}
    <div class="awaiting" role="status" transition:slide={{ duration: motion(180) }} data-testid="awaiting-banner">
      <ShieldQuestionMark size={16} aria-hidden="true" />
      <span>Alicia attend ta réponse {here ? "dans cette conversation" : "dans une autre conversation"}.</span>
      <button type="button" onclick={() => { showAwaiting(where); }} data-testid="awaiting-open">{store.busy && !here ? "Voir après cette réponse" : "Voir la question"}</button>
    </div>
  {/if}
  <div class="body">
    {#if sidebarOpen}
      <Sidebar {store} personName={session.person.name} {view} onView={showView} />
    {/if}
    <main>
      <!-- The chat stays mounted while Souvenirs is shown: its draft and scroll position are kept. -->
      <div class="pane chat" class:hidden={view !== "chat"} inert={view !== "chat"}>
        <ChatView {store} personName={session.person.name} onAnswered={() => { composerFocus++; }} />
        <Composer {store} status={shownStatus} focusRequests={composerFocus} />
      </div>
      {#if view === "memories"}
        <div class="pane" transition:fade={{ duration: motion(180) }}>
          <MemoryView screen={memories} conversationBusy={store.busy} onOpenConversation={openConversation} />
        </div>
      {/if}
      {#if view === "settings"}
        <div class="pane" transition:fade={{ duration: motion(180) }}>
          <SettingsView {session} {api} status={shownStatus} onSignOut={signOut} />
        </div>
      {/if}
    </main>
  </div>
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; }
  .body { flex: 1; min-height: 0; display: flex; }
  /* Both views share one cell, so they cross-fade in place. */
  main { flex: 1; min-width: 0; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); background: var(--night); }
  .pane { grid-area: 1 / 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .awaiting {
    flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 16px;
    background: var(--night-deep); color: var(--cream); border-bottom: 1px solid var(--amber);
  }
  .awaiting :global(svg) { flex: none; color: var(--amber); }
  .awaiting span { flex: 1; min-width: 0; }
  .awaiting button {
    border: 1px solid var(--amber); border-radius: 9px; padding: 4px 12px; background: none; color: var(--amber);
    font-weight: 700; cursor: pointer; transition: background var(--duration) ease, color var(--duration) ease;
  }
  .awaiting button:hover { background: var(--amber); color: var(--night); }
  .chat { transition: opacity var(--duration) ease, visibility 0s; }
  .chat.hidden { opacity: 0; visibility: hidden; transition: opacity var(--duration) ease, visibility 0s linear var(--duration); }
</style>
