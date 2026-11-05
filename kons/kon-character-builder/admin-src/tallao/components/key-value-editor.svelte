<!--
  tallao — KeyValueEditor
  List of key → value pairs, each with a remove button, plus a row to add
  another (variables, headers, column-to-field maps…). The key is typed
  or, with `keyOptions`, picked from a list. The pairs are a list, not an
  object: that keeps their order and, with `unique={false}`, allows
  repeated keys.

  Values are always text; with `valueType="number"` only a finite number
  is added, and the consumer converts it with Number().
-->
<script lang="ts" module>
  export interface KeyValueEntry {
    key: string;
    value: string;
  }
</script>

<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";
  import Button from "./button.svelte";
  import Input from "./input.svelte";
  import Select from "./select.svelte";

  const L = useLabels();

  let {
    entries = $bindable([]),
    keyOptions,
    keyPlaceholder = "",
    valuePlaceholder = "",
    valueType = "text",
    separator = "=",
    unique = true,
    keyLabel = "Key",
    valueLabel = "Value",
    addLabel = "Add",
    removeLabel = "Remove",
    emptyText = L.noResults,
    disabled = false,
    name,
    class: className = "",
    onchange,
  }: {
    entries?: KeyValueEntry[];
    /** The key is picked from this list instead of typed. */
    keyOptions?: string[];
    keyPlaceholder?: string;
    valuePlaceholder?: string;
    valueType?: "text" | "number";
    /** What is drawn between key and value in each row ("=", "→", ":"…). */
    separator?: string;
    /** With `true`, adding a key that already exists changes its value instead of repeating it. */
    unique?: boolean;
    /** Accessible names of the two fields in the add row. */
    keyLabel?: string;
    valueLabel?: string;
    addLabel?: string;
    /** Text of the remove button; its accessible name appends the key. */
    removeLabel?: string;
    /** What shows when there are no pairs: the list does not disappear. */
    emptyText?: string;
    disabled?: boolean;
    /** Name in a form: each pair is submitted as `name[key]=value`. */
    name?: string;
    class?: string;
    onchange?: (entries: KeyValueEntry[]) => void;
  } = $props();

  // A key picked from the list starts at the first option, like a <select> with no empty option.
  let newKey = $state("");
  let newValue = $state("");

  // With a list, a key that is no longer in it falls back to the first option.
  const chosenKey = $derived(
    keyOptions ? (keyOptions.includes(newKey) ? newKey : (keyOptions[0] ?? "")) : newKey.trim()
  );
  // An <input type="number"> returns a number or null: normalize it to text.
  const typedValue = $derived(String(newValue ?? "").trim());
  const valueIsValid = $derived(
    typedValue !== "" && (valueType !== "number" || Number.isFinite(Number(typedValue)))
  );
  const canAdd = $derived(!disabled && chosenKey !== "" && valueIsValid);

  function update(next: KeyValueEntry[]) {
    entries = next;
    onchange?.(next);
  }

  function add() {
    if (!canAdd) return;
    const pair = { key: chosenKey, value: typedValue };
    const i = unique ? entries.findIndex((e) => e.key === pair.key) : -1;
    update(i >= 0 ? entries.map((e, j) => (j === i ? pair : e)) : [...entries, pair]);
    if (!keyOptions) newKey = "";
    newValue = "";
  }

  function remove(index: number) {
    update(entries.filter((_, j) => j !== index));
  }

  // Enter in either field adds the pair, like the button.
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
  }
</script>

<div class={cn("ta-kv", className)}>
  {#if name}
    {#each entries as e, i (i)}<input type="hidden" name={`${name}[${e.key}]`} value={e.value} />{/each}
  {/if}
  {#if entries.length}
    <ul class="ta-kv-list">
      {#each entries as pair, i (`${i}:${pair.key}`)}
        <li class="ta-kv-row">
          <span class="ta-kv-pair">
            <span class="ta-kv-key">{pair.key}</span>
            <span class="ta-kv-separator" aria-hidden="true">{separator}</span>
            <span class="ta-kv-value">{pair.value}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            {disabled}
            ariaLabel={`${removeLabel} ${pair.key}`}
            onclick={() => remove(i)}
          >
            {removeLabel}
          </Button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="ta-kv-empty">{emptyText}</p>
  {/if}

  <div class="ta-kv-new">
    <div class="ta-kv-key-field">
      {#if keyOptions}
        <Select
          value={chosenKey}
          onchange={(e: Event) => (newKey = (e.currentTarget as HTMLSelectElement).value)}
          options={keyOptions.map((o) => ({ value: o, label: o }))}
          disabled={disabled || keyOptions.length === 0}
          aria-label={keyLabel}
          onkeydown={onKey}
        />
      {:else}
        <Input
          bind:value={newKey}
          placeholder={keyPlaceholder}
          {disabled}
          aria-label={keyLabel}
          autocomplete="off"
          spellcheck="false"
          onkeydown={onKey}
        />
      {/if}
    </div>
    <div class="ta-kv-value-field">
      <Input
        bind:value={newValue}
        type={valueType}
        placeholder={valuePlaceholder}
        {disabled}
        aria-label={valueLabel}
        autocomplete="off"
        onkeydown={onKey}
      />
    </div>
    <Button variant="secondary" size="sm" disabled={!canAdd} onclick={add}>
      {addLabel}
    </Button>
  </div>
</div>

<style>
  .ta-kv {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  .ta-kv-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }

  .ta-kv-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    font-size: 0.875rem;
  }

  .ta-kv-row + .ta-kv-row {
    border-top: 1px solid rgb(var(--ta-border));
  }

  .ta-kv-pair {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }

  .ta-kv-key {
    font-family: var(--ta-font-mono);
    color: rgb(var(--ta-text));
    overflow-wrap: anywhere;
  }

  .ta-kv-separator {
    color: rgb(var(--ta-text-dim));
  }

  .ta-kv-value {
    font-family: var(--ta-font-mono);
    color: rgb(var(--ta-text-dim));
    overflow-wrap: anywhere;
  }

  .ta-kv-empty {
    margin: 0;
    padding: 0.5rem 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-kv-new {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .ta-kv-key-field {
    flex: 0 1 12rem;
    min-width: 8rem;
  }

  .ta-kv-value-field {
    flex: 1 1 12rem;
    min-width: 8rem;
  }
</style>
