<!--
  The name of something the user gave a colour to (a state, a label, a module), with that colour
  as a small swatch before it. The colour is the user's data, so it is the one place a colour
  does not come from a token; the name is always there, so the colour is never the only cue.
-->
<script lang="ts">
  const { color, name }: { color?: string | null; name: string } = $props();
</script>

<span class="named">
  {#if color}<span class="swatch" style:background={color} aria-hidden="true"></span>{/if}
  <span>{name}</span>
</span>

<style>
  .named {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .swatch {
    flex-shrink: 0;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 0.1875rem;
    border: 1px solid rgb(var(--ta-border));
  }
</style>
