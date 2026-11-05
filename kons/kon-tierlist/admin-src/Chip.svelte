<!--
  A chip's face: portrait (or initials) and name. The drag, the selection and the keys belong to
  the DragItem that wraps it.
-->
<script lang="ts">
  import { initials } from "./format";
  import type { Item } from "./types";

  const { item }: { item: Item } = $props();

  // A broken portrait cannot collapse the chip: with no height, the whole row gets misaligned and
  // can no longer be dropped onto.
  let broken = $state(false);
</script>

{#if item.imageUrl && !broken}
  <img src={item.imageUrl} alt="" loading="lazy" draggable="false" onerror={() => (broken = true)} />
{:else}
  <span class="initials" aria-hidden="true">{initials(item.label)}</span>
{/if}
<span class="name">{item.label}</span>

<style>
  img,
  .initials {
    width: 26px;
    height: 26px;
    border-radius: 3px;
    object-fit: cover;
    flex: none;
  }

  .initials {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: rgb(var(--ta-elevated));
    color: rgb(var(--ta-text-dim));
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
