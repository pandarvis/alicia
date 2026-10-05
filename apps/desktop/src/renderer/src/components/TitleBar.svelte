<script lang="ts">
  import House from "@lucide/svelte/icons/house";
  import Menu from "@lucide/svelte/icons/menu";
  import MessageCircle from "@lucide/svelte/icons/message-circle";
  import PictureInPicture2 from "@lucide/svelte/icons/picture-in-picture-2";
  import { fade } from "svelte/transition";
  import { motion } from "../lib/motion.ts";
  import type { ConnectionStatus } from "../../../shared/chat-connection.ts";

  let { title, personName, status, sidebarOpen, onToggleSidebar, holoShown, onToggleHolo }: {
    title: string;
    personName: string;
    status: ConnectionStatus;
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    /** Whether Alicia floats on the desktop (the Holo); null until the settings are read. */
    holoShown: boolean | null;
    onToggleHolo: () => void;
  } = $props();

  const holoLabel = $derived(holoShown === true ? "Rattacher Alicia" : "Détacher Alicia");

  const STATUS_LABEL: Readonly<Record<ConnectionStatus, string>> = {
    connecting: "Connexion…",
    ready: "",
    offline: "Hors ligne, reconnexion…",
    rejected: "Appareil refusé",
  };
</script>

<header class="titlebar">
  <button class="icon" onclick={onToggleSidebar} title="Afficher ou masquer le menu" aria-label="Menu" aria-expanded={sidebarOpen}><Menu size={17} aria-hidden="true" /></button>
  <div class="segment" role="tablist">
    <button class="on" role="tab" aria-selected="true"><MessageCircle size={14} aria-hidden="true" />Chat</button>
    <button role="tab" aria-selected="false" disabled title="Bientôt"><House size={14} aria-hidden="true" />Maison</button>
  </div>
  <span class="title" data-testid="titlebar-title">{title}</span>
  <span class="person">{personName}</span>
  {#if STATUS_LABEL[status] !== ""}
    <span class="status" data-testid="connection-status" transition:fade={{ duration: motion(150) }}>{STATUS_LABEL[status]}</span>
  {/if}
  <span class="spacer"></span>
  <button
    class="icon holo"
    class:on={holoShown === true}
    onclick={onToggleHolo}
    disabled={holoShown === null}
    title={holoLabel}
    aria-label={holoLabel}
    aria-pressed={holoShown === true}
    data-testid="titlebar-holo"
  ><PictureInPicture2 size={17} aria-hidden="true" /></button>
</header>

<style>
  .titlebar {
    height: var(--titlebar-height); flex: none; display: flex; align-items: center; gap: 10px;
    padding: 0 150px 0 10px; /* right: Windows caption buttons overlay */
    background: var(--night-deep); border-bottom: 1px solid var(--surface); color: var(--cream-muted);
    -webkit-app-region: drag; user-select: none;
  }
  button { -webkit-app-region: no-drag; }
  .icon { display: grid; place-items: center; color: var(--cream-muted); background: none; border: 0; padding: 4px 8px; border-radius: 6px; cursor: pointer; transition: background var(--duration) ease; }
  .icon:hover { background: var(--surface); }
  .icon:disabled { opacity: 0.5; cursor: default; }
  .holo { transition: background var(--duration) ease, color var(--duration) ease, opacity var(--duration) ease; }
  .holo.on { color: var(--sage); background: var(--surface); }
  .holo.on:hover { background: var(--surface-raised); }
  .segment { display: flex; background: var(--surface); border-radius: 8px; padding: 2px; }
  .segment button { display: inline-flex; align-items: center; gap: 6px; background: none; border: 0; padding: 3px 10px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .segment button.on { background: var(--surface-raised); color: var(--cream); }
  .segment button:disabled { opacity: 0.5; cursor: default; }
  .title { color: var(--cream); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
  .person { background: var(--surface); border-radius: 6px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
  .status { color: var(--amber); font-size: 12px; white-space: nowrap; }
  .spacer { flex: 1; }
</style>
