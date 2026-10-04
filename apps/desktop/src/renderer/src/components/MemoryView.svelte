<script lang="ts">
  import { onMount } from "svelte";
  import type { MemoryScreen } from "../lib/memory-screen.svelte.ts";

  let { screen, onOpenConversation }: {
    screen: MemoryScreen;
    onOpenConversation: (conversationId: string) => void;
  } = $props();

  onMount(() => {
    void screen.load();
  });
</script>

<section class="memories" data-testid="memory-view">
  <p>{screen.items.length} souvenirs</p>
  {#each screen.items as memory (memory.id)}
    {#if memory.conversationId !== null && memory.conversationTitle !== null}
      {@const conversationId = memory.conversationId}
      <button onclick={() => { onOpenConversation(conversationId); }}>{memory.conversationTitle}</button>
    {/if}
  {/each}
</section>

<style>
  .memories { flex: 1; min-height: 0; overflow-y: auto; padding: 24px; color: var(--cream-muted); }
</style>
