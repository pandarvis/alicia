<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { motion } from "../lib/motion.ts";
  import type { DiscoveredBrain } from "../../../shared/discovery.ts";
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
  let codeInput = $state<HTMLInputElement | null>(null);
  /** How long the screen says it is searching before pointing to the manual address. */
  const SEARCH_MS = 6000;
  let brains = $state<DiscoveredBrain[]>([]);
  let searching = $state(true);
  /** Once the person typed or chose an address, a brain found later no longer replaces it. */
  let addressTouched = false;

  onMount(() => {
    // Address and device name are prefilled: the code is the only thing left to type.
    codeInput?.focus();
    void window.alicia.deviceName().then((name) => {
      if (deviceName === "") deviceName = name;
    });
    const off = window.alicia.discovery.onChange(showBrains);
    void window.alicia.discovery.start().then(showBrains, () => undefined);
    const timer = setTimeout(() => {
      searching = false;
    }, SEARCH_MS);
    return () => {
      off();
      clearTimeout(timer);
      void window.alicia.discovery.stop().catch(() => undefined);
    };
  });

  function showBrains(list: DiscoveredBrain[]): void {
    brains = list;
    if (list.length > 0) searching = false;
    const [only] = list;
    // A single brain at home: its address is filled in for the person.
    if (!addressTouched && list.length === 1 && only !== undefined) serverUrl = only.url;
  }

  function choose(brain: DiscoveredBrain): void {
    serverUrl = brain.url;
    addressTouched = true;
    codeInput?.focus();
  }

  /** Pairs with the brain and stores the session; returns an error message, or null once paired. */
  async function pairAndSave(): Promise<string | null> {
    const result = await pair(fetch, serverUrl, code, deviceName.trim());
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

  /** Keeps digits only, so a pasted "123 456" becomes "123456". */
  function onCodeInput(event: Event & { currentTarget: HTMLInputElement }): void {
    code = event.currentTarget.value.replace(/\D/g, "").slice(0, 6);
    // The state may not change (e.g. a letter typed), so the field is reset explicitly.
    event.currentTarget.value = code;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // Enter in a field submits the form even while a pairing is in flight.
    if (pending || code.length !== 6) return;
    pending = true;
    error = null;
    error = await pairAndSave();
    pending = false;
  }
</script>

<div class="screen" in:fade={{ duration: motion(200) }}>
  <div class="drag"></div>
  <form class="card" onsubmit={submit} aria-describedby="pairing-error-live">
    <Mascot mood={error === null ? "listening" : "alert"} size={160} />
    <h1>Bonjour, je suis Alicia</h1>
    <p class="lead">Pour faire connaissance, demande un code d'appairage au cerveau (commande <code>pair</code>).</p>
    {#if notice}<p class="notice" data-testid="pairing-notice">{notice}</p>{/if}
    <!-- The three states share one cell and cross-fade in place. -->
    <div class="found" aria-live="polite">
      {#if brains.length > 0}
        <div class="state" transition:fade={{ duration: motion(150) }}>
          <p class="found-label">Trouvée sur le réseau</p>
          <ul>
            {#each brains as brain (brain.name)}
              <li transition:fade={{ duration: motion(150) }}>
                <button type="button" class="brain" class:selected={serverUrl === brain.url} onclick={() => { choose(brain); }} data-testid="discovered-brain">
                  <span class="brain-name">{brain.name}</span>
                  <span class="brain-url">{brain.url}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {:else if searching}
        <p class="state found-label" data-testid="discovery-searching" transition:fade={{ duration: motion(150) }}>Recherche d'Alicia sur le réseau…</p>
      {:else}
        <p class="state found-label" data-testid="discovery-none" transition:fade={{ duration: motion(150) }}>
          Pas trouvée sur le réseau : saisis son adresse ci-dessous (avec Tailscale, par exemple http://mac-mini:8780).
        </p>
      {/if}
    </div>
    <label>Adresse d'Alicia<input bind:value={serverUrl} oninput={() => { addressTouched = true; }} data-testid="pairing-server" autocomplete="off" spellcheck="false" /></label>
    <label>Code à 6 chiffres<input bind:this={codeInput} value={code} oninput={onCodeInput} inputmode="numeric" data-testid="pairing-code" autocomplete="off" /></label>
    <label>Nom de cet appareil<input bind:value={deviceName} maxlength="60" data-testid="pairing-device" /></label>
    <!-- Always in the DOM so screen readers reliably announce each new error; the visible copy below fades. -->
    <p id="pairing-error-live" class="sr-only" aria-live="assertive">{error ?? ""}</p>
    {#if error}<p class="error" aria-hidden="true" data-testid="pairing-error" transition:fade={{ duration: motion(150) }}>{error}</p>{/if}
    <button type="submit" disabled={pending || code.length !== 6} data-testid="pairing-submit">
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
  .sr-only {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap;
  }
  .notice { margin: 0; color: var(--amber); font-size: 14px; text-align: center; }
  .found { width: 100%; display: grid; }
  .state { grid-area: 1 / 1; display: flex; flex-direction: column; gap: 6px; }
  .found-label { margin: 0; font-size: 13px; color: var(--cream-muted); }
  .found ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .brain {
    margin-top: 0; width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    padding: 8px 11px; border: 1px solid transparent; background: var(--surface); color: var(--cream);
    font-weight: 400; text-align: left; transition: border-color var(--duration) ease;
  }
  .brain.selected, .brain:hover { border-color: var(--sage); }
  .brain-name { font-weight: 700; }
  .brain-url { font-size: 12px; color: var(--muted); }
</style>
