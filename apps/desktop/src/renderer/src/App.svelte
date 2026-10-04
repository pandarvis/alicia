<script lang="ts">
  import { onMount } from "svelte";
  import type { StoredSession } from "../../shared/session.ts";
  import PairingScreen from "./components/PairingScreen.svelte";
  import Shell from "./components/Shell.svelte";

  let session = $state<StoredSession | null>(null);
  let loaded = $state(false);
  let notice = $state<string | null>(null);

  onMount(() => {
    void loadSession();
    // Signed out from another window (or by the main process): back to pairing here too.
    return window.alicia.onSessionChanged((next) => {
      if (next === null) {
        session = null;
      } else if (session?.token !== next.token) {
        session = next;
        notice = null;
      }
    });
  });

  async function loadSession(): Promise<void> {
    try {
      session = await window.alicia.getSession();
    } catch {
      // An unreadable session is the same as none: the device pairs again.
      session = null;
    }
    loaded = true;
  }

  async function signOut(message: string | null): Promise<void> {
    try {
      await window.alicia.clearSession();
    } catch {
      // Even if the file can't be removed, this window forgets the session.
    }
    session = null;
    notice = message;
  }

  /** Sign-out bound to one session: a late call from a previous Shell can't wipe a newer pairing. */
  function signOutHandler(token: string): (message: string | null) => void {
    return (message) => {
      if (session?.token === token) void signOut(message);
    };
  }

  function handlePaired(paired: StoredSession): void {
    session = paired;
    notice = null;
  }
</script>

{#if loaded}
  {#if session}
    {#key session.token}
      <Shell {session} onSignOut={signOutHandler(session.token)} />
    {/key}
  {:else}
    <PairingScreen {notice} onPaired={handlePaired} />
  {/if}
{/if}
