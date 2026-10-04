<script lang="ts">
  import { MASCOT_IMAGES } from "../lib/mascot-images.ts";
  import { MASCOT_STATES, type MascotState } from "../lib/mascot.ts";

  let { mood, size = 128 }: { mood: MascotState; size?: number } = $props();
</script>

<!-- Every pose is stacked; only the current one is opaque, so mood changes cross-fade. -->
<div class="mascot" style:width="{size}px" style:height="{size}px" role="img" aria-label="Alicia" data-testid="mascot" data-mood={mood}>
  {#each MASCOT_STATES as state (state)}
    <img src={MASCOT_IMAGES[state]} alt="" draggable="false" class:visible={state === mood} />
  {/each}
</div>

<style>
  .mascot { position: relative; flex: none; }
  img {
    position: absolute; inset: 0; width: 100%; height: 100%;
    opacity: 0; transition: opacity 220ms ease;
  }
  img.visible { opacity: 1; }
</style>
