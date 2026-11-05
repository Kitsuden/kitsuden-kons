<script lang="ts">
  const { color }: { color?: string | null } = $props();
</script>

<span class="dot" style:background={color || "rgb(var(--ta-subtle))"} aria-hidden="true"></span>

<style>
  .dot {
    display: inline-block;
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 9999px;
    margin-right: 0.4rem;
    vertical-align: middle;
    flex-shrink: 0;
  }
</style>
