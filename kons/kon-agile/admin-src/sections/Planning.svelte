<script lang="ts">
  import Cycles from "./Cycles.svelte";
  import Initiatives from "./Initiatives.svelte";
  import Modules from "./Modules.svelte";
</script>

<div class="stack">
  <Cycles />
  <Modules />
  <Initiatives />
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
