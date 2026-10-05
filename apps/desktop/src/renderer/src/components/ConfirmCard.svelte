<script lang="ts">
  import ShieldQuestionMark from "@lucide/svelte/icons/shield-question-mark";
  import { fade } from "svelte/transition";
  import { type ConfirmationCard, isSettled } from "../lib/chat-store.svelte.ts";
  import { motion } from "../lib/motion.ts";

  let { card, compact = false, onanswer }: {
    card: ConfirmationCard;
    /** The Holo's mini-chat: narrower, smaller text. */
    compact?: boolean;
    onanswer: (approved: boolean) => void;
  } = $props();

  const OUTCOMES: Readonly<Record<ConfirmationCard["status"], string>> = {
    pending: "",
    answering: "",
    approved: "Confirmé.",
    refused: "Refusé : Alicia ne l'a pas fait.",
    expired: "Sans réponse pendant 5 minutes : Alicia ne l'a pas fait.",
    cancelled: "Connexion perdue : Alicia ne l'a pas fait.",
  };
  const settled = $derived(isSettled(card.status));
</script>

<!-- Never takes the focus: the person may be typing. « Non » comes first. -->
<div class="card" class:settled class:compact role="group" aria-label="Demande de confirmation" data-testid="confirm-card" data-status={card.status}>
  <p class="question"><ShieldQuestionMark size={compact ? 14 : 16} aria-hidden="true" />{card.summary}</p>
  <!-- Buttons and outcome share one cell: the card keeps its height while one fades into the other. -->
  <div class="foot">
    {#if settled}
      <p class="outcome {card.status}" role="status" in:fade={{ duration: motion(180), delay: motion(120) }} data-testid="confirm-outcome">{OUTCOMES[card.status]}</p>
    {:else}
      <div class="actions" out:fade={{ duration: motion(120) }}>
        <button type="button" class="no" disabled={card.status === "answering"} onclick={() => { onanswer(false); }} data-testid="confirm-no">Non</button>
        <button type="button" class="yes" disabled={card.status === "answering"} onclick={() => { onanswer(true); }} data-testid="confirm-yes">Oui</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .card {
    max-width: 72%; padding: 10px 13px; border-radius: 14px; border: 1px solid var(--amber);
    background: var(--surface); display: flex; flex-direction: column; gap: 8px;
    transition: border-color var(--duration) ease, opacity var(--duration) ease;
  }
  .card.compact { max-width: 92%; padding: 8px 10px; gap: 6px; font-size: 14px; align-self: flex-start; }
  .card.settled { border-color: var(--surface-raised); opacity: 0.85; }
  .question { margin: 0; display: flex; gap: 8px; align-items: flex-start; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .question :global(svg) { flex: none; margin-top: 3px; color: var(--amber); }
  .foot { display: grid; }
  .foot > * { grid-area: 1 / 1; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  button {
    border: 0; border-radius: 9px; padding: 6px 14px; cursor: pointer; font-weight: 700;
    transition: background var(--duration) ease, opacity var(--duration) ease, filter var(--duration) ease;
  }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  button:disabled { opacity: 0.5; cursor: default; }
  .no { background: var(--night-deep); color: var(--cream); border: 1px solid var(--surface-raised); }
  .yes { background: var(--sage); color: var(--night); }
  .outcome { margin: 0; align-self: center; font-size: 13px; color: var(--muted); }
  .outcome.approved { color: var(--sage); }
</style>
