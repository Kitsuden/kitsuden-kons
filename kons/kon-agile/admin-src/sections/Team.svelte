<script lang="ts">
  import Schedules from "./Schedules.svelte";
  import Squads from "./Squads.svelte";
</script>

<div class="stack">
  <Squads />
  <Schedules />
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
