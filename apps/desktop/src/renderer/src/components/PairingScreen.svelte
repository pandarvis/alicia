<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import type { SaveSessionResult, StoredSession } from "../../../shared/session.ts";
  import { pair, type PairingFailure } from "../lib/brain-client.ts";
  import Mascot from "./Mascot.svelte";

  let { notice, onPaired }: { notice: string | null; onPaired: (session: StoredSession) => void } = $props();

  const PAIRING_MESSAGES: Readonly<Record<PairingFailure, string>> = {
    invalid_code: "Code invalide ou expiré. Demande-en un nouveau.",
    too_many_attempts: "Trop d'essais : réessaie dans une minute.",
    invalid_request: "Vérifie l'adresse d'Alicia, le code (6 chiffres) et le nom de l'appareil.",
    unreachable: "Impossible de joindre Alicia à cette adresse.",
  };
  type SaveFailure = Extract<SaveSessionResult, { ok: false }>["reason"];
  const SAVE_MESSAGES: Readonly<Record<SaveFailure, string>> = {
    encryption_unavailable: "Impossible d'enregistrer la session sur ce PC (chiffrement Windows indisponible).",
    invalid_session: "Session invalide, recommence l'appairage.",
  };
  const SAVE_FAILED = "Impossible d'enregistrer la session sur ce PC.";

  let serverUrl = $state("http://127.0.0.1:8780");
  let code = $state("");
  let deviceName = $state("");
  let error = $state<string | null>(null);
  let pending = $state(false);

  onMount(() => {
    void window.alicia.deviceName().then((name) => {
      if (deviceName === "") deviceName = name;
    });
  });

  /** Pairs with the brain and stores the session; returns an error message, or null once paired. */
  async function pairAndSave(): Promise<string | null> {
    const result = await pair(fetch, serverUrl, code.trim(), deviceName.trim());
    if (!result.ok) return PAIRING_MESSAGES[result.reason];
    let saved: SaveSessionResult;
    try {
      saved = await window.alicia.saveSession(result.session);
    } catch {
      return SAVE_FAILED;
    }
    if (!saved.ok) return SAVE_MESSAGES[saved.reason];
    onPaired(result.session);
    return null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    pending = true;
    error = null;
    error = await pairAndSave();
    pending = false;
  }
</script>

<div class="screen" in:fade={{ duration: 200 }}>
  <div class="drag"></div>
  <form class="card" onsubmit={submit}>
    <Mascot mood={error === null ? "listening" : "alert"} size={160} />
    <h1>Bonjour, je suis Alicia</h1>
    <p class="lead">Pour faire connaissance, demande un code d'appairage au cerveau (commande <code>pair</code>).</p>
    {#if notice}<p class="notice" data-testid="pairing-notice">{notice}</p>{/if}
    <label>Adresse d'Alicia<input bind:value={serverUrl} data-testid="pairing-server" autocomplete="off" spellcheck="false" /></label>
    <label>Code à 6 chiffres<input bind:value={code} inputmode="numeric" maxlength="6" data-testid="pairing-code" autocomplete="off" /></label>
    <label>Nom de cet appareil<input bind:value={deviceName} maxlength="60" data-testid="pairing-device" /></label>
    {#if error}<p class="error" role="alert" data-testid="pairing-error" transition:fade={{ duration: 150 }}>{error}</p>{/if}
    <button type="submit" disabled={pending || code.trim().length !== 6} data-testid="pairing-submit">
      {pending ? "Connexion…" : "Appairer"}
    </button>
  </form>
</div>

<style>
  /* Scrolls inside itself (never the page) when the window is too short for the card. */
  .screen { height: 100%; overflow-y: auto; display: grid; place-items: center; position: relative; padding: var(--titlebar-height) 16px 16px; }
  .drag { position: absolute; inset: 0 0 auto 0; height: var(--titlebar-height); -webkit-app-region: drag; }
  .card {
    width: min(420px, 90vw); display: flex; flex-direction: column; align-items: center; gap: 12px;
    background: var(--night-deep); border: 1px solid var(--surface); border-radius: 18px; padding: 28px;
  }
  h1 { margin: 4px 0 0; font-size: 22px; }
  .lead { margin: 0 0 8px; color: var(--cream-muted); text-align: center; font-size: 14px; }
  code { color: var(--sage); }
  label { width: 100%; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--cream-muted); }
  input {
    background: var(--surface); border: 1px solid transparent; border-radius: 8px; padding: 9px 11px;
    transition: border-color var(--duration) ease;
  }
  input:focus { outline: none; border-color: var(--sage); }
  button {
    margin-top: 6px; width: 100%; padding: 10px; border: 0; border-radius: 10px; cursor: pointer;
    background: var(--sage); color: var(--night); font-weight: 700; transition: opacity var(--duration) ease;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .error { margin: 0; color: var(--amber); font-size: 14px; text-align: center; }
  .notice { margin: 0; color: var(--amber); font-size: 14px; text-align: center; }
</style>
