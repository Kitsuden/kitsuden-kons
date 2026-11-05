<!-- The row a table shows when it has nothing. -->
<script lang="ts">
  import { TableCell, TableRow } from "$lib/components";

  const { columns, text }: { columns: number; text: string } = $props();
</script>

<TableRow>
  <TableCell colspan={columns}><span class="empty">{text}</span></TableCell>
</TableRow>

<style>
  .empty {
    color: rgb(var(--ta-text-dim));
  }
</style>
