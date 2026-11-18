<!--
  tallao — Combobox
  Text field with a list of options filtered as you type (WAI-ARIA 1.2
  combobox pattern, with aria-activedescendant: focus never leaves the
  field). For long lists where a <select> falls short.
    - ↓ opens the list or moves down; ↑ moves up; Enter picks the active option.
    - Escape closes the list; with the list closed, it clears the typed text.
    - The filter ignores case and accents ("cancion" finds "Canción").
  `value` is the chosen value (or null); the field's text is only the search.

  Remote search: with `loadOptions(query, signal)` options come from the API as
  you type (debounced between keystrokes and cancelling the previous request); the
  server does the filtering.
  Multiple values: with `multiple`, `values` is the chosen list; each value is a
  chip with its remove button, picking an option adds or removes it and the list
  stays open; Backspace in the empty field removes the last one.
  Forms: with `name` it renders hidden inputs (one per value), so it submits in a
  native <form>, even without JavaScript after server rendering (SvelteKit).
-->
<script lang="ts" module>
  export interface ComboboxOption {
    value: string;
    label: string;
    disabled?: boolean;
  }

  /** Lowercase and without accents, for comparing. */
  export const normalizeText = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
</script>

<script lang="ts">
  import { untrack } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";
  import { pushLayer } from "$lib/internal/layers";
  import { anchor } from "$lib/internal/position";

  interface Props {
    /** Local options; with `loadOptions` they may be omitted (they come from the API). */
    options?: ComboboxOption[];
    value?: string | null;
    /** With `multiple`: the chosen values. */
    values?: string[];
    multiple?: boolean;
    /** Options from the API for the typed text; `signal` is aborted if another search arrives. */
    loadOptions?: (query: string, signal: AbortSignal) => Promise<ComboboxOption[]>;
    /** Wait after the last keystroke before searching the API, in ms. */
    debounce?: number;
    /** Minimum characters to search the API. */
    minChars?: number;
    /** Field name in a form (hidden inputs with the value or values). */
    name?: string;
    required?: boolean;
    placeholder?: string;
    /** Accessible name if it is not inside a Field. */
    ariaLabel?: string;
    /** List text when nothing matches. */
    emptyText?: string;
    loadingText?: string;
    /** Name of the button that removes a chip (`multiple` mode). */
    removeLabel?: (label: string) => string;
    disabled?: boolean;
    /** Custom filter for local options; defaults to "contains", ignoring case and accents. */
    filter?: (option: ComboboxOption, query: string) => boolean;
    class?: string;
    onValueChange?: (value: string | null) => void;
    onValuesChange?: (values: string[]) => void;
  }

  const L = useLabels();
  let {
    options = [],
    value = $bindable(null),
    values = $bindable([]),
    multiple = false,
    loadOptions,
    debounce = 250,
    minChars = 0,
    name,
    required = false,
    placeholder,
    ariaLabel,
    emptyText = L.noResults,
    loadingText = L.loading,
    removeLabel = (label: string) => `${L.remove} ${label}`,
    disabled = false,
    filter = (o, q) => normalizeText(o.label).includes(normalizeText(q)),
    class: className = "",
    onValueChange,
    onValuesChange,
  }: Props = $props();

  const id = $props.id();
  let field: HTMLInputElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let open = $state(false);
  let active = $state(-1);
  // The typed text; when not typing (single mode), the field shows the chosen option.
  let text = $state("");
  let typing = $state(false);

  // Remote: the last thing the API returned, and what has been seen, to name what was chosen.
  let remoteOptions = $state<ComboboxOption[]>([]);
  let loading = $state(false);
  let known = $state<Record<string, ComboboxOption>>({});
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;

  $effect(() => {
    for (const o of options)
      if (!known[o.value])
        untrack(() => {
          known[o.value] = o;
        });
  });

  const labelOf = (v: string) => known[v]?.label ?? options.find((o) => o.value === v)?.label ?? v;
  const selected = $derived(value == null ? null : (known[value] ?? options.find((o) => o.value === value) ?? null));
  const selectedSet = $derived(new Set(multiple ? values : value == null ? [] : [value]));
  const visible = $derived(
    loadOptions ? remoteOptions : typing && text ? options.filter((o) => filter(o, text)) : options
  );

  // Single mode: if the value changes from outside, the field reflects it.
  $effect(() => {
    if (!multiple && !typing) text = selected?.label ?? "";
  });

  function search(q: string, now = false) {
    if (!loadOptions) return;
    clearTimeout(debounceTimer);
    request?.abort();
    if (q.length < minChars) {
      remoteOptions = [];
      loading = false;
      return;
    }
    loading = true;
    const run = () => {
      const controller = new AbortController();
      request = controller;
      loadOptions(q, controller.signal).then(
        (res) => {
          if (controller.signal.aborted) return;
          remoteOptions = res;
          for (const o of res) known[o.value] = o;
          loading = false;
          active = nextEnabled(-1, 1);
        },
        () => {
          if (!controller.signal.aborted) loading = false;
        }
      );
    };
    if (now) run();
    else debounceTimer = setTimeout(run, debounce);
  }

  function openList() {
    if (disabled) return;
    open = true;
    if (loadOptions && remoteOptions.length === 0) search(multiple ? text : "", true);
    const i = visible.findIndex((o) => selectedSet.has(o.value));
    active = i >= 0 ? i : nextEnabled(-1, 1);
  }

  function closeList() {
    open = false;
    active = -1;
    typing = false;
    clearTimeout(debounceTimer);
    request?.abort();
    loading = false;
    text = multiple ? "" : (selected?.label ?? "");
  }

  function choose(o: ComboboxOption) {
    if (o.disabled) return;
    known[o.value] = o;
    if (multiple) {
      values = values.includes(o.value) ? values.filter((v) => v !== o.value) : [...values, o.value];
      onValuesChange?.(values);
      text = "";
      typing = false;
      field?.focus();
      return;
    }
    value = o.value;
    onValueChange?.(o.value);
    typing = false;
    text = o.label;
    open = false;
    active = -1;
  }

  function remove(v: string) {
    values = values.filter((x) => x !== v);
    onValuesChange?.(values);
    field?.focus();
  }

  /** The next non-disabled option in direction `step`, wrapping around. */
  function nextEnabled(from: number, step: 1 | -1) {
    const n = visible.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + step * k + n * 2) % n;
      if (!visible[i].disabled) return i;
    }
    return -1;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      active = nextEnabled(active, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      if (open && active >= 0 && visible[active]) {
        e.preventDefault();
        choose(visible[active]);
      }
    } else if (e.key === "Backspace" && multiple && text === "" && values.length) {
      remove(values[values.length - 1]);
    } else if (e.key === "Escape" && !open && text) {
      // With the list open, Escape is handled by the layer stack (it closes it).
      e.preventDefault();
      text = "";
      typing = true;
    }
  }

  function onInput() {
    typing = true;
    open = true;
    if (loadOptions) search(text);
    else active = nextEnabled(-1, 1);
  }

  // The active option stays visible even when the list scrolls.
  $effect(() => {
    if (open && active >= 0) list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  });

  $effect(() => {
    const l = list;
    const c = field;
    if (!open || !l || !c) return;
    const release = anchor(c, l, { matchWidth: true, gap: 4 });
    const removeLayer = pushLayer({ inside: () => [l, c], dismiss: closeList });
    return () => {
      removeLayer();
      release();
    };
  });

  // On unmount no search is left in flight.
  $effect(() => () => {
    clearTimeout(debounceTimer);
    request?.abort();
  });
</script>

<div class={cn("ta-combobox", multiple && "ta-combobox--multiple", className)}>
  {#if name}
    {#if multiple}
      {#each values as v (v)}<input type="hidden" {name} value={v} />{/each}
    {:else}
      <input type="hidden" {name} value={value ?? ""} />
    {/if}
  {/if}

  <div class="ta-combobox-box">
    {#if multiple}
      {#each values as v (v)}
        <span class="ta-combobox-chip">
          {labelOf(v)}
          <button
            type="button"
            class="ta-combobox-remove"
            aria-label={removeLabel(labelOf(v))}
            {disabled}
            onclick={() => remove(v)}>×</button
          >
        </span>
      {/each}
    {/if}
    <input
      bind:this={field}
      bind:value={text}
      type="text"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={`${id}-list`}
      aria-activedescendant={open && active >= 0 ? `${id}-op-${active}` : undefined}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      aria-required={required || undefined}
      placeholder={multiple && values.length ? undefined : placeholder}
      {disabled}
      class="ta-combobox-field"
      oninput={onInput}
      onkeydown={onKey}
      onclick={() => (open ? null : openList())}
    />
  </div>
  <svg class="ta-combobox-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>

  {#if open}
    <ul
      bind:this={list}
      id={`${id}-list`}
      role="listbox"
      aria-label={ariaLabel}
      aria-multiselectable={multiple || undefined}
      aria-busy={loading || undefined}
      popover="manual"
      class="ta-combobox-list"
    >
      {#each visible as o, i (o.value)}
        <!-- The pointer picks without taking focus from the field (mousedown with preventDefault). -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={`${id}-op-${i}`}
          data-index={i}
          role="option"
          aria-selected={selectedSet.has(o.value)}
          aria-disabled={o.disabled ? "true" : undefined}
          class="ta-combobox-option"
          class:ta-combobox-option--active={i === active}
          onmousedown={(e) => e.preventDefault()}
          onpointermove={() => !o.disabled && (active = i)}
          onclick={() => choose(o)}
        >
          {#if multiple}<span class="ta-combobox-check" aria-hidden="true">{selectedSet.has(o.value) ? "✓" : ""}</span>{/if}
          {o.label}
        </li>
      {:else}
        <li class="ta-combobox-empty" role="presentation">{loading ? loadingText : emptyText}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ta-combobox {
    position: relative;
    width: 100%;
  }

  .ta-combobox-box {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }

  .ta-combobox--multiple .ta-combobox-box {
    padding: 0.25rem 2rem 0.25rem 0.375rem;
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
  }
  .ta-combobox--multiple .ta-combobox-box:focus-within {
    border-color: rgb(var(--ta-accent) / 0.5);
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15);
  }

  .ta-combobox-field {
    width: 100%;
    padding: 0.5rem 2rem 0.5rem 0.75rem;
    font: inherit;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .ta-combobox--multiple .ta-combobox-field {
    flex: 1;
    min-width: 6rem;
    width: auto;
    padding: 0.25rem 0.375rem;
    border: none;
    background: transparent;
  }

  .ta-combobox:not(.ta-combobox--multiple) .ta-combobox-field:focus {
    border-color: rgb(var(--ta-accent) / 0.5);
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15);
  }

  .ta-combobox-field:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ta-combobox-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.25rem 0.125rem 0.5rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated));
    border-radius: 9999px;
  }

  .ta-combobox-remove {
    padding: 0 0.3rem;
    font: inherit;
    line-height: 1.1;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: 9999px;
    cursor: pointer;
  }
  .ta-combobox-remove:hover { color: rgb(var(--ta-danger)); }
  .ta-combobox-remove:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); }

  .ta-combobox-chevron {
    position: absolute;
    right: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    color: rgb(var(--ta-text-dim));
    pointer-events: none;
  }

  .ta-combobox-list {
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 50;
    max-height: min(16rem, var(--ta-available-height, 16rem));
    overflow-y: auto;
    padding: 0.25rem;
    list-style: none;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.45);
    font: inherit;
  }

  .ta-combobox-option {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4rem 0.6rem;
    font-size: 0.875rem;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }

  .ta-combobox-check {
    width: 0.875rem;
    color: rgb(var(--ta-accent-hover));
  }

  .ta-combobox-option--active {
    background: rgb(var(--ta-elevated));
  }

  .ta-combobox-option[aria-selected="true"] {
    font-weight: 600;
    color: rgb(var(--ta-accent-hover));
  }

  .ta-combobox-option[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ta-combobox-empty {
    padding: 0.5rem 0.6rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  /* On touch screens: 44px options for the finger. */
  @media (pointer: coarse) {
    .ta-combobox-option { min-height: 2.75rem; }
  }
</style>
