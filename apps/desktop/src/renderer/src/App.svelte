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
    await window.alicia.clearSession();
    session = null;
    notice = message;
  }

  function handleSignOut(message: string | null): void {
    void signOut(message);
  }

  function handlePaired(paired: StoredSession): void {
    session = paired;
    notice = null;
  }
</script>

{#if loaded}
  {#if session}
    {#key session.token}
      <Shell {session} onSignOut={handleSignOut} />
    {/key}
  {:else}
    <PairingScreen {notice} onPaired={handlePaired} />
  {/if}
{/if}
