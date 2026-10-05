<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { fade, slide } from "svelte/transition";
  import { DEFAULT_SHORTCUT } from "../../../shared/accelerator.ts";
  import type { ConnectionStatus } from "../../../shared/chat-connection.ts";
  import type { StoredSession } from "../../../shared/session.ts";
  import type { UpdateStatus } from "../../../shared/updates.ts";
  import type { BrainApi } from "../lib/brain-client.ts";
  import { readKeyboardLayout } from "../lib/keyboard-layout.ts";
  import { mirror } from "../lib/mirror.ts";
  import { motion } from "../lib/motion.ts";
  import { SettingsScreen } from "../lib/settings-screen.svelte.ts";

  let { session, api, status, onSignOut }: {
    session: StoredSession;
    api: BrainApi;
    status: ConnectionStatus;
    onSignOut: () => void;
  } = $props();

  const uid = $props.id();
  const screen = new SettingsScreen(window.alicia.settings, () => readKeyboardLayout());
  const STATUS_LABEL: Readonly<Record<ConnectionStatus, string>> = {
    connecting: "Connexion…",
    ready: "Connectée",
    offline: "Hors ligne, reconnexion…",
    rejected: "Appareil refusé",
  };

  let deviceName = $state("…");
  let appVersion = $state("…");
  let brainVersion = $state<string | null>(null);
  let update = $state<UpdateStatus>({ state: "disabled" });
  let captureButton = $state<HTMLButtonElement | null>(null);
  let confirming = $state(false);
  let signOutButton = $state<HTMLButtonElement | null>(null);
  let cancelButton = $state<HTMLButtonElement | null>(null);
  /** Set when the question is dismissed, so the focus goes back to "Déconnecter cet appareil". */
  let returnFocus = false;
  const settings = $derived(screen.snapshot?.settings ?? null);
  const busy = $derived(settings === null || screen.saving);

  onMount(() => {
    screen.start();
    void window.alicia.deviceName().then((name) => {
      deviceName = name;
    });
    void window.alicia.app.version().then((version) => {
      appVersion = version;
    });
    void api.health().then(
      (health) => {
        brainVersion = health.version;
      },
      () => {
        brainVersion = null;
      },
    );
    return mirror(() => window.alicia.updates.status(), (listener) => window.alicia.updates.onChange(listener), (status) => {
      update = status;
    });
  });

  function updateLabel(status: UpdateStatus): string {
    switch (status.state) {
      case "disabled":
        return "Les mises à jour automatiques fonctionnent dans l'app installée, une fois appairée.";
      case "idle":
      case "up_to_date":
        return `Alicia est à jour (version ${appVersion}).`;
      case "checking":
        return "Recherche d'une mise à jour…";
      case "downloading":
        return `Téléchargement de la mise à jour… ${status.percent} %`;
      case "ready":
        return `La version ${status.version} est prête.`;
      case "error":
        return "Impossible de vérifier les mises à jour pour l'instant.";
    }
  }
  onDestroy(() => {
    screen.stop();
  });

  // The capture button takes the focus: the next key press is the new shortcut.
  $effect(() => {
    if (screen.capturing) captureButton?.focus();
  });

  function handleCaptureKeydown(event: KeyboardEvent): void {
    // Tab still leaves (and the blur cancels the capture).
    if (event.key === "Tab") return;
    event.preventDefault();
    void screen.captureKey(event);
  }

  function askSignOut(): void {
    confirming = true;
  }

  function cancelSignOut(): void {
    returnFocus = true;
    confirming = false;
  }

  function handleConfirmKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancelSignOut();
  }

  // The safe answer gets the focus when the question shows up; the button gets it back afterwards.
  $effect(() => {
    if (confirming) {
      cancelButton?.focus();
    } else if (returnFocus && signOutButton !== null) {
      returnFocus = false;
      signOutButton.focus();
    }
  });
</script>

<div class="settings" data-testid="settings-view">
  <div class="content">
    <h1>Réglages</h1>

    <section aria-labelledby="{uid}-quick">
      <h2 id="{uid}-quick">Accès rapide</h2>
      <div class="row">
        <div class="label">
          <p class="name" id="{uid}-shortcut">Raccourci de la barre Spotlight</p>
          <p class="hint">Ouvre, par-dessus tout, une barre pour écrire à Alicia.</p>
        </div>
        {#if screen.capturing}
          <button
            class="capture"
            bind:this={captureButton}
            onkeydown={handleCaptureKeydown}
            onblur={() => { screen.cancelCapture(); }}
            aria-describedby="{uid}-shortcut"
            data-testid="settings-shortcut-capture"
            in:fade={{ duration: motion(120) }}
          >Appuie sur la combinaison… (Échap pour annuler)</button>
        {:else}
          <kbd data-testid="settings-shortcut" in:fade={{ duration: motion(120) }}>{settings?.shortcut ?? "…"}</kbd>
          <button class="link" onclick={() => { screen.startCapture(); }} disabled={busy} data-testid="settings-shortcut-change">Modifier</button>
          {#if settings !== null && settings.shortcut !== DEFAULT_SHORTCUT}
            <button class="link" onclick={() => void screen.resetShortcut()} disabled={busy} data-testid="settings-shortcut-reset" transition:fade={{ duration: motion(120) }}>Rétablir {DEFAULT_SHORTCUT}</button>
          {/if}
        {/if}
      </div>
      {#if screen.snapshot !== null && !screen.snapshot.shortcutActive}
        <p class="warning" role="status" data-testid="settings-shortcut-inactive" transition:slide={{ duration: motion(150) }}>
          Ce raccourci ne marche pas : une autre application l'utilise déjà. Choisis-en un autre.
        </p>
      {/if}
      <div class="row">
        <div class="label">
          <p class="name" id="{uid}-holo">Afficher l'Holo</p>
          <p class="hint">Alicia flotte sur le bureau, toujours au-dessus ; un clic ouvre une petite discussion.</p>
        </div>
        <button class="switch" role="switch" aria-checked={settings?.showHolo ?? false} aria-labelledby="{uid}-holo" disabled={busy} onclick={() => void screen.toggleHolo()} data-testid="settings-holo"><span class="knob"></span></button>
      </div>
      <div class="row">
        <div class="label">
          <p class="name" id="{uid}-startup">Lancer Alicia au démarrage de Windows</p>
          <p class="hint">Elle démarre discrètement dans la zone de notification.</p>
        </div>
        <button class="switch" role="switch" aria-checked={settings?.launchAtStartup ?? false} aria-labelledby="{uid}-startup" disabled={busy} onclick={() => void screen.toggleStartup()} data-testid="settings-startup"><span class="knob"></span></button>
      </div>
    </section>

    <section aria-labelledby="{uid}-device">
      <h2 id="{uid}-device">Cet appareil</h2>
      <dl>
        <dt>Adresse d'Alicia</dt><dd data-testid="settings-server">{session.serverUrl}</dd>
        <dt>Connexion</dt><dd>{STATUS_LABEL[status]}</dd>
        <dt>Personne</dt><dd>{session.person.name}</dd>
        <dt>Nom de l'appareil</dt><dd>{deviceName}</dd>
        <dt>Version de l'app</dt><dd data-testid="settings-app-version">{appVersion}</dd>
        <dt>Version d'Alicia</dt><dd>{brainVersion ?? "inconnue"}</dd>
      </dl>
      <div class="signout">
        {#if confirming}
          <div class="confirm" role="group" aria-labelledby="{uid}-question" aria-describedby="{uid}-confirm-hint" data-testid="sign-out-confirm" in:fade={{ duration: motion(150) }}>
            <p id="{uid}-question" class="question">Déconnecter cet appareil ?</p>
            <p id="{uid}-confirm-hint" class="hint">Il faudra l'appairer à nouveau.</p>
            <div class="actions">
              <button class="yes" onclick={onSignOut} onkeydown={handleConfirmKeydown} data-testid="sign-out-yes">Oui</button>
              <button class="no" bind:this={cancelButton} onclick={cancelSignOut} onkeydown={handleConfirmKeydown} data-testid="sign-out-cancel">Annuler</button>
            </div>
          </div>
        {:else}
          <button class="danger" bind:this={signOutButton} onclick={askSignOut} data-testid="sign-out" in:fade={{ duration: motion(150) }}>Déconnecter cet appareil</button>
        {/if}
      </div>
    </section>

    <section aria-labelledby="{uid}-updates">
      <h2 id="{uid}-updates">Mises à jour</h2>
      <div class="row">
        <p class="label hint" data-testid="settings-updates">{updateLabel(update)}</p>
        {#if update.state === "ready"}
          <button class="link" onclick={() => void window.alicia.updates.install()} data-testid="settings-update-install" transition:fade={{ duration: motion(150) }}>Redémarrer pour installer</button>
        {/if}
      </div>
    </section>

    {#if screen.error}
      <p class="error" role="status" data-testid="settings-error" transition:fade={{ duration: motion(150) }}>{screen.error}</p>
    {/if}
  </div>
</div>

<style>
  .settings { height: 100%; overflow-y: auto; }
  .content { max-width: 720px; margin: 0 auto; padding: 24px 32px 40px; display: flex; flex-direction: column; gap: 24px; }
  h1 { margin: 0; font-size: 22px; }
  section { display: flex; flex-direction: column; gap: 4px; }
  h2 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--night-deep); border-radius: var(--radius); }
  .label { flex: 1; min-width: 0; }
  .name { margin: 0; color: var(--cream); font-weight: 700; }
  .hint { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  kbd { font: inherit; font-weight: 700; padding: 4px 10px; border-radius: 8px; background: var(--surface); color: var(--cream); }
  button { font: inherit; cursor: pointer; border: 0; transition: background var(--duration) ease, color var(--duration) ease, opacity var(--duration) ease; }
  button:disabled { cursor: default; opacity: 0.6; }
  .link { background: none; color: var(--sage); padding: 4px 6px; border-radius: 6px; }
  .link:hover:not(:disabled) { background: var(--surface); }
  .capture { padding: 6px 12px; border-radius: 8px; background: var(--surface-raised); color: var(--cream); box-shadow: 0 0 0 1px var(--sage); }
  .warning, .error { margin: 4px 2px 0; color: var(--amber); font-size: 13px; }
  .switch { position: relative; width: 40px; height: 22px; flex: none; border-radius: 11px; background: var(--surface-raised); }
  .switch[aria-checked="true"] { background: var(--sage); }
  .knob { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--cream); transition: transform var(--duration) ease; }
  .switch[aria-checked="true"] .knob { transform: translateX(18px); }
  dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; padding: 12px 14px; background: var(--night-deep); border-radius: var(--radius); font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; color: var(--cream); overflow-wrap: anywhere; }
  .signout { margin-top: 8px; }
  .danger { background: none; color: var(--amber); padding: 6px 2px; }
  .danger:hover { text-decoration: underline; }
  .confirm { display: flex; flex-direction: column; gap: 2px; }
  .question { margin: 0; color: var(--cream); font-weight: 700; }
  .actions { display: flex; gap: 6px; margin-top: 6px; }
  .actions button { padding: 4px 12px; border-radius: 8px; font-size: 13px; }
  .yes { background: var(--surface-raised); color: var(--amber); font-weight: 700; }
  .no { background: none; color: var(--cream-muted); }
  .actions button:hover { background: var(--surface); }
</style>
