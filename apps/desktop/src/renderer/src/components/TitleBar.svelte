<script lang="ts">
  import { fade } from "svelte/transition";
  import type { ConnectionStatus } from "../lib/chat-connection.ts";

  let { title, personName, status, onToggleSidebar }: {
    title: string;
    personName: string;
    status: ConnectionStatus;
    onToggleSidebar: () => void;
  } = $props();

  const STATUS_LABEL: Readonly<Record<ConnectionStatus, string>> = {
    connecting: "Connexion…",
    ready: "",
    offline: "Hors ligne, reconnexion…",
    rejected: "Appareil refusé",
  };
</script>

<header class="titlebar">
  <button class="icon" onclick={onToggleSidebar} title="Afficher ou masquer le menu" aria-label="Menu">☰</button>
  <div class="segment" role="tablist">
    <button class="on" role="tab" aria-selected="true">💬 Chat</button>
    <button role="tab" aria-selected="false" disabled title="Bientôt">🏠 Maison</button>
  </div>
  <span class="title" data-testid="titlebar-title">{title}</span>
  <span class="person">{personName}</span>
  {#if STATUS_LABEL[status] !== ""}
    <span class="status" data-testid="connection-status" transition:fade={{ duration: 150 }}>{STATUS_LABEL[status]}</span>
  {/if}
  <span class="spacer"></span>
</header>

<style>
  .titlebar {
    height: var(--titlebar-height); flex: none; display: flex; align-items: center; gap: 10px;
    padding: 0 150px 0 10px; /* right: Windows caption buttons overlay */
    background: var(--night-deep); border-bottom: 1px solid var(--surface); color: var(--cream-muted);
    -webkit-app-region: drag; user-select: none;
  }
  button { -webkit-app-region: no-drag; }
  .icon { background: none; border: 0; padding: 4px 8px; border-radius: 6px; cursor: pointer; transition: background var(--duration) ease; }
  .icon:hover { background: var(--surface); }
  .segment { display: flex; background: var(--surface); border-radius: 8px; padding: 2px; }
  .segment button { background: none; border: 0; padding: 3px 10px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .segment button.on { background: var(--surface-raised); color: var(--cream); }
  .segment button:disabled { opacity: 0.5; cursor: default; }
  .title { color: var(--cream); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
  .person { background: var(--surface); border-radius: 6px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
  .status { color: var(--amber); font-size: 12px; white-space: nowrap; }
  .spacer { flex: 1; }
</style>
