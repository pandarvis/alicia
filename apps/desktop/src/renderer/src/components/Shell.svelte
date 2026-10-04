<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import type { ServerEvent } from "@alicia/protocol";
  import type { StoredSession } from "../../../shared/session.ts";
  import { BrainApi, UnauthorizedError, webSocketUrl } from "../lib/brain-client.ts";
  import { browserSocket, ChatConnection, type ConnectionStatus } from "../lib/chat-connection.ts";
  import { ChatStore } from "../lib/chat-store.svelte.ts";
  import ChatView from "./ChatView.svelte";
  import Composer from "./Composer.svelte";
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
  /** Set once the connection dropped, so the next `ready` resynchronizes what was missed. */
  let wasOffline = false;

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
    newId: () => crypto.randomUUID(),
    schedule,
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
    openSocket: browserSocket,
    schedule,
    onEvent: handleEvent,
    onStatus: handleStatus,
  });

  const title = $derived(store.conversations.find((c) => c.id === store.activeId)?.title ?? "Nouvelle conversation");

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
  <TitleBar {title} personName={session.person.name} {status} onToggleSidebar={toggleSidebar} />
  <div class="body">
    {#if sidebarOpen}
      <Sidebar {store} personName={session.person.name} onSignOut={signOut} />
    {/if}
    <main>
      <ChatView {store} personName={session.person.name} />
      <Composer {store} {status} />
    </main>
  </div>
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; }
  .body { flex: 1; min-height: 0; display: flex; }
  main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--night); }
</style>
