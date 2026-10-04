<script lang="ts">
  import type { StoredSession } from "../../../shared/session.ts";
  let { session, onSignOut }: { session: StoredSession; onSignOut: (message: string | null) => void } = $props();
</script>

<!-- Provisional, replaced by the main window in task 8. -->
<div class="shell">
  <p>Connecté en tant que {session.person.name}</p>
  <button onclick={() => { onSignOut(null); }}>Déconnecter</button>
</div>

<style>
  /* A flex container keeps the paragraph's margin from collapsing through the root (no stray scrollbar). */
  .shell { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
  p { margin: 0; }
  button { background: none; border: 0; color: var(--muted); cursor: pointer; }
</style>
