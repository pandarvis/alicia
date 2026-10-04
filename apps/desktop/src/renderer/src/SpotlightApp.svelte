<script lang="ts">
  import { onMount } from "svelte";
  import { fade, fly } from "svelte/transition";
  import type { ConnectionStatus } from "../../shared/chat-connection.ts";
  import type { MascotState } from "../../shared/mascot.ts";
  import Mascot from "./components/Mascot.svelte";
  import { mirror } from "./lib/mirror.ts";
  import { motion } from "./lib/motion.ts";
  import { throttle, TYPING_INTERVAL_MS } from "./lib/throttle.ts";

  const FADE_MS = 160;
  const UNREACHABLE = "Alicia n'est pas joignable pour l'instant.";
  /** Typing is reported a few times a second at most, not on every key. */
  const typing = throttle(() => { window.alicia.presence.typing(); }, TYPING_INTERVAL_MS);

  let paired = $state(false);
  let status = $state<ConnectionStatus>("connecting");
  let mood = $state<MascotState>("idle");
  let text = $state("");
  let error = $state<string | null>(null);
  let sending = $state(false);
  let shown = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  onMount(() => {
    const offs = [
      mirror(() => window.alicia.paired(), (listener) => window.alicia.onPairedChanged(listener), (next) => {
        paired = next;
      }),
      mirror(() => window.alicia.brain.status(), (listener) => window.alicia.brain.onStatus(listener), (next) => {
        status = next;
      }),
      mirror(() => window.alicia.presence.current(), (listener) => window.alicia.presence.onChange(listener), (next) => {
        mood = next;
      }),
      window.alicia.surface.onShown(open),
      window.alicia.surface.onHideRequest(() => {
        void close();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  });

  // Each time the bar appears, the cursor is in it.
  $effect(() => {
    if (shown) input?.focus();
  });

  function open(): void {
    text = "";
    error = null;
    sending = false;
    shown = true;
  }

  /** Read through a call: `shown` changes while `close` waits for the exit animation. */
  function isShown(): boolean {
    return shown;
  }

  async function close(): Promise<void> {
    shown = false;
    await new Promise((resolve) => setTimeout(resolve, motion(FADE_MS)));
    // Shown again meanwhile: stay.
    if (!isShown()) await window.alicia.surface.hideSelf();
  }

  async function submit(): Promise<void> {
    const message = text.trim();
    if (message === "" || sending) return;
    if (!paired) {
      await window.alicia.app.showMain();
      await close();
      return;
    }
    if (status !== "ready") {
      error = UNREACHABLE;
      return;
    }
    sending = true;
    error = null;
    let delivered = false;
    try {
      // Each message from the bar starts a new conversation.
      delivered = await window.alicia.brain.send({ type: "send", requestId: crypto.randomUUID(), text: message });
    } catch {
      delivered = false;
    }
    sending = false;
    if (!delivered) {
      error = UNREACHABLE;
      return;
    }
    // The answer comes back as a notification.
    await close();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      void close();
    }
  }
</script>

<div class="stage">
  {#if shown}
    <div class="bar" transition:fly={{ y: -12, duration: motion(FADE_MS) }} data-testid="spotlight">
      <Mascot {mood} size={44} />
      <input
        bind:this={input}
        bind:value={text}
        onkeydown={handleKeydown}
        oninput={typing}
        maxlength="2000"
        disabled={sending}
        placeholder={paired ? "Demande à Alicia…" : "Appaire d'abord Alicia : Entrée ouvre l'app"}
        aria-label="Message pour Alicia"
        autocomplete="off"
        data-testid="spotlight-input"
      />
      <kbd aria-hidden="true">Entrée</kbd>
    </div>
    {#if error}
      <p class="error" role="status" transition:fade={{ duration: motion(120) }} data-testid="spotlight-error">{error}</p>
    {/if}
  {/if}
</div>

<style>
  .stage { position: fixed; inset: 0; padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; }
  .bar {
    display: flex; align-items: center; gap: 12px; height: 64px; padding: 0 16px 0 10px;
    background: var(--night-deep); border: 1px solid var(--surface-raised); border-radius: 18px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
  }
  input { flex: 1; min-width: 0; border: 0; background: none; font-size: 19px; color: var(--cream); }
  input:focus { outline: none; }
  input::placeholder { color: var(--muted); }
  kbd { font: inherit; font-size: 12px; color: var(--muted); border: 1px solid var(--surface-raised); border-radius: 6px; padding: 2px 6px; }
  .error { margin: 0 12px; color: var(--amber); font-size: 13px; text-shadow: 0 1px 2px rgb(0 0 0 / 0.6); }
</style>
