<script lang="ts">
  import Estimates from "./Estimates.svelte";
  import Fields from "./Fields.svelte";
  import Labels from "./Labels.svelte";
</script>

<div class="stack">
  <Labels />
  <Estimates />
  <Fields />
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
