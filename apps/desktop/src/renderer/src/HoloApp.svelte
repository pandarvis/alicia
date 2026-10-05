<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import type { HoloView } from "../../shared/holo.ts";
  import type { MascotState } from "../../shared/mascot.ts";
  import type { StoredSession } from "../../shared/session.ts";
  import HoloChat from "./components/HoloChat.svelte";
  import Mascot from "./components/Mascot.svelte";
  import { DragTracker } from "./lib/drag.ts";
  import { MiniChat } from "./lib/mini-chat.svelte.ts";
  import { mirror } from "./lib/mirror.ts";
  import { motion } from "./lib/motion.ts";

  const FADE_MS = 180;
  const MOOD_LABEL: Readonly<Record<MascotState, string>> = {
    idle: "Alicia",
    sleeping: "Alicia somnole",
    listening: "Alicia t'écoute",
    thinking: "Alicia réfléchit",
    speaking: "Alicia te répond",
    success: "C'est fait !",
    alert: "Alicia a besoin de toi",
    error: "Quelque chose n'a pas marché",
    idea: "Alicia a une idée",
  };

  let session = $state<StoredSession | null>(null);
  let mood = $state<MascotState>("idle");
  let view = $state<HoloView>({
    expanded: false, panelSide: "left", mascot: { edgeX: "right", x: 0, edgeY: "bottom", y: 0 },
  });
  /** Each size request gets a number: only the reply to the latest one is applied (open and close may cross). */
  let viewRequest = 0;
  let mascotButton = $state<HTMLButtonElement | null>(null);
  let shown = $state(false);
  let chatOpen = $state(false);
  let chat = $state<MiniChat | null>(null);
  const token = $derived(session?.token ?? null);

  /** A lost IPC call (window closing, main process busy) is logged, never an unhandled rejection. */
  function logFailure(error: unknown): void {
    console.error("Holo: call to the main process failed", error);
  }

  const drag = new DragTracker({
    start: () => {
      window.alicia.holo.dragStart().catch(logFailure);
    },
    // The main process follows the pointer itself (right across screens of different scales).
    move: () => {
      window.alicia.holo.dragMove().catch(logFailure);
    },
    end: () => {
      window.alicia.holo.dragEnd().catch(logFailure);
    },
    click: () => {
      void toggleChat();
    },
  });

  onMount(() => {
    const offs = [
      mirror(() => window.alicia.getSession(), (listener) => window.alicia.onSessionChanged(listener), (next) => {
        session = next;
      }),
      mirror(() => window.alicia.presence.current(), (listener) => window.alicia.presence.onChange(listener), (next) => {
        mood = next;
      }),
      window.alicia.surface.onShown(() => {
        shown = true;
      }),
      window.alicia.surface.onHideRequest(() => {
        void hide();
      }),
      // Dragged across the screen, or a screen changed: the main process says how to lay out now.
      window.alicia.holo.onView((next) => {
        view = next;
      }),
      // A notification: Alicia waits in the mini-chat for a yes or no.
      window.alicia.holo.onOpenChat(() => {
        if (!chatOpen) void toggleChat();
      }),
    ];
    void requestView(false);
    // The window only exists to be shown: play the entrance now.
    shown = true;
    return () => {
      for (const off of offs) off();
    };
  });

  // One mini-chat conversation per pairing, kept while the app runs (also while the panel is closed).
  $effect(() => {
    if (token === null) return;
    const current = untrack(() => session);
    if (current === null) return;
    const created = new MiniChat(current, window.alicia.brain, fetch);
    created.start();
    chat = created;
    return () => {
      created.stop();
      chat = null;
    };
  });

  /** Asks the main process to grow or shrink the window; true when this is still the latest request. */
  async function requestView(expanded: boolean): Promise<boolean> {
    const request = ++viewRequest;
    try {
      const next = await window.alicia.holo.setExpanded(expanded);
      if (request !== viewRequest) return false;
      view = next;
      return true;
    } catch (error) {
      logFailure(error);
      return false;
    }
  }

  /** Opening: the window grows first, then the panel slides in. Closing: the panel slides out, then the window shrinks. */
  async function toggleChat(): Promise<void> {
    if (chatOpen) {
      closeChat();
      return;
    }
    if (await requestView(true)) chatOpen = true;
  }

  /** The keyboard focus goes back to the mascot, where the mini-chat was opened from. */
  function closeChat(): void {
    chatOpen = false;
    mascotButton?.focus();
  }

  async function collapse(): Promise<void> {
    if (chatOpen) return;
    await requestView(false);
  }

  /** Read through a call: `shown` changes while `hide` waits for the exit animation. */
  function isShown(): boolean {
    return shown;
  }

  async function hide(): Promise<void> {
    shown = false;
    chatOpen = false;
    await new Promise((resolve) => setTimeout(resolve, motion(FADE_MS)));
    // Shown again meanwhile: stay.
    if (!isShown()) await window.alicia.surface.hideSelf();
  }

  function onPointerDown(event: PointerEvent & { currentTarget: EventTarget & HTMLButtonElement }): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.down({ x: event.screenX, y: event.screenY, pointerId: event.pointerId });
  }

  function onPointerMove(event: PointerEvent): void {
    drag.move({ x: event.screenX, y: event.screenY, pointerId: event.pointerId });
  }

  function onPointerUp(event: PointerEvent): void {
    drag.up({ x: event.screenX, y: event.screenY, pointerId: event.pointerId });
  }

  /** The gesture was taken away (pointercancel, capture lost): a drag ends where it is. */
  function onPointerLost(event: PointerEvent): void {
    drag.cancel(event.pointerId);
  }

  /** Keyboard activation only (Enter, Space): pointer clicks go through the drag tracker. */
  function onClick(event: MouseEvent): void {
    if (event.detail === 0) void toggleChat();
  }
</script>

<div class="holo" class:shown data-testid="holo">
  {#if chatOpen}
    <div
      class="panel {view.panelSide}"
      transition:fly={{ x: view.panelSide === "left" ? 24 : -24, duration: motion(200) }}
      onoutroend={() => void collapse()}
    >
      {#if chat}
        <HoloChat {chat} onClose={closeChat} />
      {:else}
        <p class="unpaired">Appaire d'abord Alicia depuis l'app.</p>
      {/if}
    </div>
  {/if}
  <button
    class="mascot"
    bind:this={mascotButton}
    style:left={view.mascot.edgeX === "left" ? `${view.mascot.x}px` : undefined}
    style:right={view.mascot.edgeX === "right" ? `${view.mascot.x}px` : undefined}
    style:top={view.mascot.edgeY === "top" ? `${view.mascot.y}px` : undefined}
    style:bottom={view.mascot.edgeY === "bottom" ? `${view.mascot.y}px` : undefined}
    title={MOOD_LABEL[mood]}
    aria-label={chatOpen ? "Fermer la discussion" : "Discuter avec Alicia"}
    aria-expanded={chatOpen}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerLost}
    onlostpointercapture={onPointerLost}
    onclick={onClick}
    data-testid="holo-mascot"
  ><span class="breathe"><Mascot {mood} size={120} /></span></button>
</div>

<style>
  .holo {
    position: fixed; inset: 0; opacity: 0; transform: scale(0.96); transform-origin: bottom center;
    transition: opacity 180ms ease, transform 180ms ease;
  }
  .holo.shown { opacity: 1; transform: none; }
  .mascot {
    position: absolute; width: 136px; height: 152px; padding: 0 0 8px; display: grid; place-items: end center;
    background: none; border: 0; border-radius: 16px; cursor: grab; touch-action: none;
  }
  .mascot:active { cursor: grabbing; }
  .mascot:focus-visible { outline: 2px solid var(--sage); outline-offset: -4px; }
  /* A slow, tiny breath: she is alive even at rest (stopped by reduced motion, app.css). */
  .breathe { display: block; animation: breathe 4.5s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: translateY(-2px); } }
  .panel { position: absolute; top: 0; bottom: 0; width: 320px; }
  .panel.left { left: 0; }
  .panel.right { right: 0; }
  .unpaired { margin: 0; padding: 16px; border-radius: 16px; background: var(--night-deep); color: var(--cream-muted); }
</style>
