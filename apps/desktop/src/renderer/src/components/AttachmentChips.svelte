<script lang="ts">
  import { formatSize } from "@alicia/protocol";
  import FileIcon from "@lucide/svelte/icons/file";
  import FileSpreadsheet from "@lucide/svelte/icons/file-spreadsheet";
  import FileText from "@lucide/svelte/icons/file-text";
  import ImageIcon from "@lucide/svelte/icons/image";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import X from "@lucide/svelte/icons/x";
  import { flip } from "svelte/animate";
  import { fly } from "svelte/transition";
  import type { DraftAttachment } from "../lib/chat-store.svelte.ts";
  import { motion } from "../lib/motion.ts";

  let { drafts, onremove }: { drafts: readonly DraftAttachment[]; onremove: (localId: string) => void } = $props();

  const ICONS = { image: ImageIcon, pdf: FileText, word: FileText, excel: FileSpreadsheet, text: FileIcon } as const;
</script>

<ul class="chips" aria-label="Pièces jointes">
  {#each drafts as draft (draft.localId)}
    {@const Icon = ICONS[draft.kind]}
    <li
      class="chip {draft.status}"
      data-testid="attachment-chip"
      data-status={draft.status}
      transition:fly={{ y: 6, duration: motion(160) }}
      animate:flip={{ duration: motion(160) }}
    >
      {#if draft.status === "uploading"}
        <LoaderCircle class="spin" size={14} aria-label="Envoi en cours" />
      {:else}
        <Icon size={14} aria-hidden="true" />
      {/if}
      <span class="name" title={draft.name}>{draft.name}</span>
      <span class="size">{draft.status === "failed" ? "échec" : formatSize(draft.size)}</span>
      <button
        type="button"
        aria-label="Retirer {draft.name}"
        title="Retirer"
        onclick={() => { onremove(draft.localId); }}
        data-testid="attachment-remove"
      ><X size={12} aria-hidden="true" /></button>
    </li>
  {/each}
</ul>

<style>
  .chips { list-style: none; margin: 0; padding: 0 4px; display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: flex; align-items: center; gap: 6px; max-width: 240px; padding: 4px 6px 4px 9px; border-radius: 999px;
    background: var(--night-deep); border: 1px solid var(--surface-raised); font-size: 13px;
    transition: border-color var(--duration) ease, color var(--duration) ease, opacity var(--duration) ease;
  }
  .chip.uploading { opacity: 0.75; }
  .chip.failed { border-color: var(--amber); color: var(--amber); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .size { color: var(--muted); flex: none; }
  .chip.failed .size { color: inherit; }
  button {
    border: 0; background: none; color: var(--cream-muted); cursor: pointer; padding: 2px; border-radius: 50%; display: flex;
    transition: background var(--duration) ease, color var(--duration) ease;
  }
  button:hover { background: var(--surface-raised); color: var(--cream); }
  .chip :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .chip :global(.spin) { animation: none; } }
</style>
