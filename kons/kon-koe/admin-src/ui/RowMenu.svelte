<!-- The actions of a table row behind one "⋯" button: DataTable's `rowActions` keeps it in view. -->
<script lang="ts" module>
  export interface RowAction {
    label: string;
    onSelect: () => void;
    /** A destructive action: it opens a ConfirmDialog, it does not act by itself. */
    danger?: boolean;
    disabled?: boolean;
    /** A rule above this item (before the destructive ones). */
    separated?: boolean;
  }
</script>

<script lang="ts">
  import { Button, DropdownMenu, MenuItem, MenuSeparator } from "$lib/components";

  const { label, items }: { label: string; items: RowAction[] } = $props();
</script>

{#if items.length}
  <DropdownMenu {label} placement="bottom-end">
    {#snippet trigger(props)}
      <Button {...props} variant="ghost" size="icon" ariaLabel={label}><span aria-hidden="true">⋯</span></Button>
    {/snippet}
    {#each items as item (item.label)}
      {#if item.separated}<MenuSeparator />{/if}
      <MenuItem onSelect={item.onSelect} disabled={item.disabled} variant={item.danger ? "danger" : "default"}>
        {item.label}
      </MenuItem>
    {/each}
  </DropdownMenu>
{/if}
