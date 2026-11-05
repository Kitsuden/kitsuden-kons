<!-- What a list says when it has nothing: the section stays visible with its gap. -->
<script lang="ts">
  const { text }: { text: string } = $props();
</script>

<p class="empty">{text}</p>

<style>
  .empty {
    margin: 0;
    padding: 0.25rem 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
