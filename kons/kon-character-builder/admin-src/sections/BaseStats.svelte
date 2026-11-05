<!-- The formulas' input values: stat = number. -->
<script lang="ts">
  import { KeyValueEditor, type KeyValueEntry } from "$lib/components";

  import { useEditor } from "../editor.svelte";
  import Panel from "../ui/Panel.svelte";

  const editor = useEditor();

  const entries = $derived(
    Object.entries(editor.def.baseStats ?? {}).map(([key, value]) => ({ key, value: String(value) }))
  );

  function change(next: KeyValueEntry[]) {
    editor.def.baseStats = Object.fromEntries(next.map((e) => [e.key, Number(e.value)]));
  }
</script>

<Panel title="Base stats">
  <KeyValueEditor
    {entries}
    onchange={change}
    valueType="number"
    keyPlaceholder="atk_base"
    valuePlaceholder="100"
    keyLabel="Base stat"
    valueLabel="Value"
    addLabel="Add base stat"
    emptyText="No base stats. The formulas will have nothing to start from."
  />
</Panel>
