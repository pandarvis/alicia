<script lang="ts">
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { fade, fly } from "svelte/transition";
  import { motion, scrollBehavior } from "../lib/motion.ts";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";
  import ConfirmCard from "./ConfirmCard.svelte";
  import Mascot from "./Mascot.svelte";

  let { store, personName, onAnswered, onReconnect }: {
    store: ChatStore;
    personName: string;
    /** A card was answered: the focus goes back to the composer (the pressed button turns off). */
    onAnswered: () => void;
    /** « Reconnecter le compte »: Comptes opens and runs Google's consent again. */
    onReconnect: (accountId: string) => void;
  } = $props();

  const SUGGESTIONS = [
    "Raconte-moi une anecdote surprenante",
    "Aide-moi à formuler un message gentil",
    "Réfléchis bien : une idée de sortie ce week-end ?",
  ];

  const greeting = (): string => {
    const hour = new Date().getHours();
    return hour >= 5 && hour < 18 ? "Bonjour" : "Bonsoir";
  };

  let list = $state<HTMLDivElement | null>(null);
  /** Alicia's last item (answer or card): her mascot sits next to it. */
  const lastAliciaId = $derived(store.messages.findLast((m) => m.role !== "user")?.id);
  const waiting = $derived(store.waiting);

  /*
   * Scrolling, like the ChatGPT/Claude apps:
   * - a message the user sends is brought to the top of the area (a spacer below the last exchange makes room);
   * - the answer then fills the space under it without moving the view, and once it outgrows the view,
   *   the view follows its end, unless the user scrolled by hand since sending (scrolling back down to the end resumes);
   * - opening a conversation shows its end at once.
   */
  /** Space (px) left above the sent message once it is brought to the top. */
  const TOP_GAP = 12;
  /** Distance (px) from the end under which a manual scroll down resumes following. */
  const RESUME_DISTANCE = 24;
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

  let spacer = $state<HTMLDivElement | null>(null);
  let viewportHeight = $state(0);
  /** The user message of the last exchange sent from here: the spacer keeps room below it. */
  let pinnedId: string | null = null;
  /** True from a send until the user scrolls by hand: the view follows the streamed answer. */
  let follow = false;
  let seenList: HTMLDivElement | null = null;
  let seenUserId: string | undefined;
  let seenLayout = "";

  /** Sizes the spacer so the pinned message can reach the top; returns its height. */
  function layoutSpacer(area: HTMLDivElement, filler: HTMLDivElement): number {
    const row = pinnedId === null ? null : area.querySelector<HTMLElement>(`[data-message-id="${pinnedId}"]`);
    let height = 0;
    if (row !== null) {
      const paddingBottom = parseFloat(getComputedStyle(area).paddingBottom);
      height = Math.max(0, area.clientHeight - paddingBottom - TOP_GAP - (filler.offsetTop - row.offsetTop));
    }
    // Set directly (not through state) so the scroll below sees the new height right away.
    filler.style.height = `${height}px`;
    return height;
  }

  $effect(() => {
    if (list === null || spacer === null) return;
    const last = store.messages.at(-1);
    const growth = last?.role === "confirmation" ? last.status : (last?.text.length ?? 0);
    const layout = `${store.messages.length}:${growth}:${waiting}:${store.activity ?? ""}:${viewportHeight}:${store.reconnectCards.length}`;
    const fresh = list !== seenList;
    if (!fresh && layout === seenLayout) return;
    seenList = list;
    seenLayout = layout;

    const lastUserId = store.messages.findLast((m) => m.role === "user")?.id;
    const sent = lastUserId !== seenUserId && store.busy && last?.role === "user";
    seenUserId = lastUserId;
    if (sent) {
      pinnedId = last.id;
      follow = true;
    } else if (fresh) {
      pinnedId = null;
      follow = false;
    }

    const room = layoutSpacer(list, spacer);
    if (sent) {
      const row = list.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`);
      if (row !== null) list.scrollTo({ top: row.offsetTop - TOP_GAP, behavior: scrollBehavior() });
    } else if (fresh) {
      list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
    } else if (follow && room === 0) {
      // The answer outgrew the view: keep its end visible (never scroll back up).
      const end = list.scrollHeight - list.clientHeight;
      if (end > list.scrollTop + 1) list.scrollTo({ top: end, behavior: "auto" });
    }
  });

  /** Wheel, keyboard or scrollbar: the user takes over the scroll until the next send. */
  function stopFollowing(target: EventTarget | null): void {
    if (list !== null && target instanceof Node && list.contains(target)) follow = false;
  }

  function handleWheel(event: WheelEvent): void {
    stopFollowing(event.target);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (SCROLL_KEYS.has(event.key)) stopFollowing(event.target);
  }

  /** Scrolling back down to the end while Alicia answers resumes following (ChatGPT style). */
  function handleScroll(): void {
    if (follow || !store.busy || list === null) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < RESUME_DISTANCE) follow = true;
  }

  function handlePointerdown(event: PointerEvent): void {
    // Only a press on the scrollbar itself (right of the content box) counts as scrolling.
    if (list !== null && event.target === list && event.offsetX >= list.clientWidth) follow = false;
  }
</script>

<svelte:window onwheel={handleWheel} onkeydown={handleKeydown} onpointerdown={handlePointerdown} />

<section class="chat">
  {#if store.messages.length === 0 && store.loading}
    <div class="center" in:fade={{ duration: motion(200) }} data-testid="chat-loading">
      <Mascot mood="thinking" size={120} />
      <p class="loading">Chargement…</p>
    </div>
  {:else if store.messages.length === 0}
    <div class="center" in:fade={{ duration: motion(200) }} data-testid="chat-welcome">
      <Mascot mood={store.mascot} size={180} />
      <h1>{greeting()} {personName}, on fait quoi ?</h1>
      <div class="suggestions">
        {#each SUGGESTIONS as suggestion (suggestion)}
          <button onclick={() => { store.send(suggestion); }} disabled={store.busy || store.loading}>{suggestion}</button>
        {/each}
      </div>
    </div>
  {:else}
    <div class="messages" bind:this={list} bind:clientHeight={viewportHeight} onscroll={handleScroll} data-testid="messages" in:fade={{ duration: motion(200) }}>
      {#each store.messages as message (message.id)}
        {#if message.role === "confirmation"}
          <div class="row assistant" data-message-id={message.id} in:fly={{ y: 8, duration: motion(180) }}>
            <div class="avatar">
              {#if message.id === lastAliciaId && !waiting}
                <div transition:fade={{ duration: motion(150) }}><Mascot mood={store.mascot} size={44} /></div>
              {/if}
            </div>
            <ConfirmCard card={message} onanswer={(approved: boolean) => { store.respond(message.confirmationId, approved); onAnswered(); }} />
          </div>
        {:else}
          <div class="row {message.role}" data-message-id={message.id} in:fly={{ y: 8, duration: motion(180) }}>
            {#if message.role === "assistant"}
              <div class="avatar">
                <!-- Only one mascot at a time: it moves to the typing row while Alicia thinks about the next answer. -->
                {#if message.id === lastAliciaId && !waiting}
                  <div transition:fade={{ duration: motion(150) }}><Mascot mood={store.mascot} size={44} /></div>
                {/if}
              </div>
            {/if}
            <div class="bubble" data-testid="message-{message.role}">
              {#if message.attachments !== undefined}
                <ul class="attached" aria-label="Pièces jointes">
                  {#each message.attachments as file, index (index)}
                    <li data-testid="message-attachment"><Paperclip size={12} aria-hidden="true" /><span>{file.name}</span></li>
                  {/each}
                </ul>
              {/if}<span class="text">{message.text}{#if message.streaming}<span class="caret"></span>{/if}</span>
            </div>
          </div>
        {/if}
      {/each}
      {#if waiting}
        <div class="row assistant" in:fade={{ duration: motion(150) }}>
          <div class="avatar"><Mascot mood={store.mascot} size={44} /></div>
          <div class="bubble typing" role="status" aria-label="Alicia réfléchit"><span></span><span></span><span></span></div>
        </div>
      {/if}
      {#if store.activity}<p class="activity" transition:fade={{ duration: motion(150) }}>{store.activity}</p>{/if}
      {#each store.reconnectCards as account (account.id)}
        <div class="reconnect" role="status" data-testid="reconnect-card" transition:fade={{ duration: motion(180) }}>
          <span>Le compte <strong>{account.email}</strong> doit être reconnecté pour qu'Alicia y accède.</span>
          <button onclick={() => { onReconnect(account.id); }} data-testid="reconnect-card-button">
            <RefreshCw size={14} aria-hidden="true" />Reconnecter le compte
          </button>
        </div>
      {/each}
      <div class="spacer" bind:this={spacer} aria-hidden="true"></div>
    </div>
  {/if}
  {#if store.notice}
    <p class="notice" role="status" data-testid="notice" transition:fade={{ duration: motion(150) }}>{store.notice}</p>
  {/if}
</section>

<style>
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .reconnect {
    margin: 0 0 8px 52px; padding: 10px 14px; border-radius: var(--radius); background: var(--night-deep);
    border: 1px solid var(--amber); display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .reconnect button {
    flex: none; display: flex; align-items: center; gap: 6px; padding: 4px 10px; border: 0; border-radius: 8px; cursor: pointer;
    background: var(--surface-raised); color: var(--amber); font-weight: 700; transition: background var(--duration) ease;
  }
  .reconnect button:hover { background: var(--surface); }
  .center { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; }
  h1 { margin: 0; font-size: 24px; text-align: center; }
  .loading { margin: 0; color: var(--muted); }
  .suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 640px; }
  .suggestions button {
    background: none; border: 1px solid var(--surface-raised); border-radius: 16px; padding: 6px 12px;
    color: var(--cream-muted); cursor: pointer; transition: border-color var(--duration) ease, color var(--duration) ease;
  }
  .suggestions button:hover:not(:disabled) { border-color: var(--sage); color: var(--cream); }
  .suggestions button:disabled { opacity: 0.6; cursor: default; }
  .messages { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 12px max(24px, calc((100% - 760px) / 2)) 20px; display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  .row.user { justify-content: flex-end; }
  .avatar { width: 44px; flex: none; }
  .bubble { max-width: 72%; padding: 9px 13px; border-radius: 14px; line-height: 1.45; overflow-wrap: anywhere; }
  /* Only the text keeps its line breaks (the markup around the files must not show). */
  .text { white-space: pre-wrap; }
  .text:empty { display: none; }
  .attached { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 13px; color: var(--cream-muted); }
  .attached:has(+ .text:not(:empty)) { margin-bottom: 4px; }
  .attached li { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .attached span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .user .bubble { background: var(--surface-raised); border-bottom-right-radius: 4px; }
  .assistant .bubble { background: var(--surface); border-bottom-left-radius: 4px; }
  .caret { display: inline-block; width: 7px; height: 1em; margin-left: 2px; vertical-align: -2px; background: var(--sage); animation: blink 1s steps(2) infinite; }
  .typing { display: flex; gap: 4px; padding: 14px 16px; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--cream-muted); animation: bounce 1.2s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }
  /* flex: none, or the empty spacer would shrink to nothing in the column. */
  .spacer { flex: none; }
  .activity { margin: 0 0 0 52px; font-size: 13px; color: var(--muted); font-style: italic; }
  .notice { margin: 0 auto 8px; padding: 6px 12px; border-radius: 8px; background: var(--night-deep); color: var(--amber); font-size: 14px; }
  @keyframes blink { 50% { opacity: 0; } }
  @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }
</style>
