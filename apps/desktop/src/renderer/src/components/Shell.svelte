<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { fade } from "svelte/transition";
  import type { ServerEvent } from "@alicia/protocol";
  import type { StoredSession } from "../../../shared/session.ts";
  import type { AppView } from "../lib/app-view.ts";
  import { BrainApi, UnauthorizedError } from "../lib/brain-client.ts";
  import { ChatConnection, type ConnectionStatus, openWebSocket, webSocketUrl } from "../../../shared/chat-connection.ts";
  import { ChatStore } from "../lib/chat-store.svelte.ts";
  import { MemoryScreen } from "../lib/memory-screen.svelte.ts";
  import { motion } from "../lib/motion.ts";
  import ChatView from "./ChatView.svelte";
  import Composer from "./Composer.svelte";
  import MemoryView from "./MemoryView.svelte";
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
    send: (message) => connection.send(message),
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

  const connection = new ChatConnection({
    url: webSocketUrl(initialSession.serverUrl),
    token: initialSession.token,
    openSocket: openWebSocket,
    schedule,
    onEvent: handleEvent,
    onStatus: handleStatus,
  });

  const title = $derived(
    view === "memories"
      ? "Souvenirs"
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

  function toggleSidebar(): void {
    sidebarOpen = !sidebarOpen;
  }

  function signOut(): void {
    onSignOut(null);
  }

  onMount(() => {
    connection.start();
    void store.refreshConversations();
  });
  onDestroy(() => {
    connection.stop();
  });
</script>

<div class="app">
  <TitleBar {title} personName={session.person.name} status={shownStatus} {sidebarOpen} onToggleSidebar={toggleSidebar} />
  <div class="body">
    {#if sidebarOpen}
      <Sidebar {store} personName={session.person.name} {view} onView={showView} onSignOut={signOut} />
    {/if}
    <main>
      <!-- The chat stays mounted while Souvenirs is shown: its draft and scroll position are kept. -->
      <div class="pane chat" class:hidden={view !== "chat"} inert={view !== "chat"}>
        <ChatView {store} personName={session.person.name} />
        <Composer {store} status={shownStatus} />
      </div>
      {#if view === "memories"}
        <div class="pane" transition:fade={{ duration: motion(180) }}>
          <MemoryView screen={memories} conversationBusy={store.busy} onOpenConversation={openConversation} />
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
  .chat { transition: opacity var(--duration) ease, visibility 0s; }
  .chat.hidden { opacity: 0; visibility: hidden; transition: opacity var(--duration) ease, visibility 0s linear var(--duration); }
</style>
