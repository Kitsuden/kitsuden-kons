<!-- tallao — MenuLabel: heading of a group of options inside a DropdownMenu (cannot be chosen). -->
<script lang="ts">
  const { children }: { children: import("svelte").Snippet } = $props();
</script>

<div role="presentation" class="ta-menu-label">{@render children()}</div>

<style>
  .ta-menu-label {
    padding: 0.35rem 0.6rem 0.2rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }
</style>
