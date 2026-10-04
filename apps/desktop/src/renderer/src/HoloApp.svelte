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
  let view = $state<HoloView>({ expanded: false, panelSide: "left", mascot: { x: 0, y: 0 } });
  let shown = $state(false);
  let chatOpen = $state(false);
  let chat = $state<MiniChat | null>(null);
  const token = $derived(session?.token ?? null);

  const drag = new DragTracker({
    start: () => {
      void window.alicia.holo.dragStart();
    },
    move: (delta) => {
      void window.alicia.holo.dragTo(delta);
    },
    end: () => {
      void window.alicia.holo.dragEnd();
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
    ];
    void window.alicia.holo.setExpanded(false).then((next) => {
      view = next;
    });
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

  /** Opening: the window grows first, then the panel slides in. Closing: the panel slides out, then the window shrinks. */
  async function toggleChat(): Promise<void> {
    if (chatOpen) {
      chatOpen = false;
      return;
    }
    view = await window.alicia.holo.setExpanded(true);
    chatOpen = true;
  }

  async function collapse(): Promise<void> {
    if (chatOpen) return;
    view = await window.alicia.holo.setExpanded(false);
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
        <HoloChat {chat} onClose={() => { chatOpen = false; }} />
      {:else}
        <p class="unpaired">Appaire d'abord Alicia depuis l'app.</p>
      {/if}
    </div>
  {/if}
  <button
    class="mascot"
    style:left="{view.mascot.x}px"
    style:top="{view.mascot.y}px"
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
