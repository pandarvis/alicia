<script lang="ts">
  import { onMount } from "svelte";
  import type { MemoryScreen } from "../lib/memory-screen.svelte.ts";
  import MemoryDetail from "./MemoryDetail.svelte";
  import MemoryList from "./MemoryList.svelte";

  let { screen, conversationBusy, onOpenConversation }: {
    screen: MemoryScreen;
    conversationBusy: boolean;
    onOpenConversation: (conversationId: string) => void;
  } = $props();

  // Every visit shows the memories as they are now (Alicia may have remembered something meanwhile).
  onMount(() => {
    void screen.load();
  });
</script>

<section class="memories" data-testid="memory-view">
  <div class="list"><MemoryList {screen} /></div>
  <div class="detail"><MemoryDetail {screen} {conversationBusy} {onOpenConversation} /></div>
</section>

<style>
  /* Layout B: the list on the left, the selected memory on the right; only the columns scroll. */
  .memories { flex: 1; min-height: 0; display: flex; }
  .list { flex: 0 0 48%; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .detail {
    flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
    background: var(--night-deep); border-left: 1px solid var(--surface);
  }
</style>
