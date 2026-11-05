<!-- What a section reports under its buttons: green for a result, red for an error. -->
<script lang="ts">
  import { Alert } from "$lib/components";

  import type { Note } from "../api";

  const { note }: { note: Note | null } = $props();
</script>

{#if note}
  <Alert variant={note.ok ? "success" : "error"}>
    {#each note.lines as line, i (i)}<span>{line}</span>{/each}
  </Alert>
{/if}
