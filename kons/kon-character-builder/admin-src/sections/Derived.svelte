<!-- Stats calculated by kon-formulas from the base ones: `{name, formula}`, in order. -->
<script lang="ts">
  import { KeyValueEditor, type KeyValueEntry } from "$lib/components";

  import { useEditor } from "../editor.svelte";
  import Panel from "../ui/Panel.svelte";

  const editor = useEditor();

  const entries = $derived(editor.def.derived.map((d) => ({ key: d.name, value: d.formula })));

  function change(next: KeyValueEntry[]) {
    editor.def.derived = next.map((e) => ({ name: e.key, formula: e.value }));
  }
</script>

<Panel title="Derived stats">
  <KeyValueEditor
    {entries}
    onchange={change}
    unique={false}
    keyPlaceholder="dmg"
    valuePlaceholder="atk_base * (1 + crit_rate / 100)"
    keyLabel="Derived stat"
    valueLabel="Formula"
    addLabel="Add derived stat"
    emptyText="No derived stats: the builder would only show the base ones."
  />
</Panel>
