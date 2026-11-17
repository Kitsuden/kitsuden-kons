<!--
  tallao — TagInput
  A list of short free-text values typed one after another: ids, emails, tags, event names. Each
  value is a chip with a remove button; a field after the chips takes the next one.

  Keyboard: Enter or the separator (comma by default) adds what was typed (also when the separator
  arrives as text, from a phone keyboard or autocomplete); pasting a list splits it
  on the separators and on new lines; Backspace in the empty field removes the last chip (and puts
  its text back to edit). Each remove button is a real button ("Remove <value>").

  Values are checked before they are added: `pattern` (a regular expression for the WHOLE value,
  as in an <input pattern>), `maxItems`, and no repeats unless `unique={false}`. What does not pass
  stays in the field with the reason under it (role="alert"); nothing is added silently.

  With `name`, each value is submitted as a hidden input `name` (repeated), so it works in a plain
  form. On the server the chips render as text; adding needs JavaScript.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  const L = useLabels();

  let {
    values = $bindable([]),
    placeholder = "",
    pattern,
    patternMessage,
    maxItems,
    unique = true,
    separators = [","],
    disabled = false,
    id,
    name,
    ariaLabel,
    removeLabel = L.removeItem,
    invalidLabel = L.invalid,
    class: className = "",
    onchange,
    ...rest
  }: {
    /** The values, in order. */
    values?: string[];
    placeholder?: string;
    /** A regular expression the whole value must match (anchored), e.g. `\d{15,20}`. */
    pattern?: string;
    /** What to say when a value does not match `pattern` (default: the "invalid" label). */
    patternMessage?: string;
    /** No more than this many values. */
    maxItems?: number;
    /** With `true` (default), a value already in the list is not added again. */
    unique?: boolean;
    /** Characters that end a value as you type or paste (Enter always does). */
    separators?: string[];
    disabled?: boolean;
    /** Id of the text field, for a <label for>. */
    id?: string;
    /** Name in a form: each value is submitted as `name` (repeated). */
    name?: string;
    /** Accessible name of the text field when there is no visible label. */
    ariaLabel?: string;
    /** Accessible name of each remove button; "{item}" is replaced by the value. */
    removeLabel?: string;
    /** Prefix of a rejection message. */
    invalidLabel?: string;
    class?: string;
    onchange?: (values: string[]) => void;
    /** Other attributes go to the text field (aria-describedby, aria-invalid…). */
    [key: string]: unknown;
  } = $props();

  const uid = $props.id();
  const errorId = `${uid}-error`;
  let draft = $state("");
  let problem = $state<string | null>(null);
  let field: HTMLInputElement | undefined = $state();

  const full = $derived(maxItems !== undefined && values.length >= maxItems);
  const re = $derived.by(() => {
    if (!pattern) return null;
    try {
      return new RegExp(`^(?:${pattern})$`);
    } catch {
      return null;
    }
  });

  function update(next: string[]) {
    values = next;
    onchange?.(next);
  }

  /** Adds each candidate that passes; returns the ones that did not, with the first reason. */
  function addAll(candidates: string[]): { rejected: string[]; reason: string | null } {
    const next = [...values];
    const rejected: string[] = [];
    let reason: string | null = null;
    for (const raw of candidates) {
      const v = raw.trim();
      if (!v) continue;
      let why: string | null = null;
      if (maxItems !== undefined && next.length >= maxItems) why = `${invalidLabel} (≤ ${maxItems})`;
      else if (re && !re.test(v)) why = patternMessage ?? `${invalidLabel}: ${v}`;
      else if (unique && next.includes(v)) why = null;
      if (why) {
        rejected.push(v);
        reason ??= why;
        continue;
      }
      if (!(unique && next.includes(v))) next.push(v);
    }
    if (next.length !== values.length) update(next);
    return { rejected, reason };
  }

  const splitter = $derived(new RegExp(`[${separators.map((s) => s.replace(/[\\\]^-]/g, "\\$&")).join("")}\\n\\r]+`));

  function commit() {
    const { rejected, reason } = addAll(draft.split(splitter));
    draft = rejected.join(separators[0] ?? ",");
    problem = reason;
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || separators.includes(e.key)) {
      if (e.key === "Enter" && draft.trim() === "") return;
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && values.length) {
      e.preventDefault();
      const last = values[values.length - 1];
      update(values.slice(0, -1));
      draft = last;
      problem = null;
    }
  }

  /**
   * A separator that arrives without its key (an Android keyboard sends "Unidentified", autocomplete
   * and dictation insert text): what is before the last separator is added, what follows stays.
   */
  function oninput() {
    problem = null;
    if (!splitter.test(draft)) return;
    const parts = draft.split(splitter);
    const rest = parts.pop() ?? "";
    const { rejected, reason } = addAll(parts);
    draft = [...rejected, rest].filter((p) => p !== "").join(separators[0] ?? ",");
    problem = reason;
  }

  function onpaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!splitter.test(text)) return;
    e.preventDefault();
    draft = `${draft}${text}`;
    commit();
  }

  function remove(i: number) {
    update(values.filter((_, j) => j !== i));
    problem = null;
    field?.focus();
  }
</script>

<div class={cn("ta-tag-input", disabled && "ta-tag-input--disabled", className)}>
  {#if name}
    {#each values as v, i (i)}<input type="hidden" {name} value={v} />{/each}
  {/if}
  <ul class="ta-tag-input-list">
    {#each values as v, i (`${i}:${v}`)}
      <li class="ta-tag-input-chip">
        <span class="ta-tag-input-text">{v}</span>
        <button
          type="button"
          class="ta-tag-input-remove"
          aria-label={removeLabel.replace("{item}", v)}
          {disabled}
          onclick={() => remove(i)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />
          </svg>
        </button>
      </li>
    {/each}
    <li class="ta-tag-input-entry">
      <input
        {...rest}
        bind:this={field}
        bind:value={draft}
        {id}
        type="text"
        class="ta-tag-input-field"
        placeholder={full ? "" : placeholder}
        disabled={disabled || full}
        aria-label={ariaLabel}
        aria-invalid={problem ? "true" : (rest["aria-invalid"] as "true" | "false" | undefined)}
        aria-describedby={[problem ? errorId : null, rest["aria-describedby"] as string | undefined].filter(Boolean).join(" ") || undefined}
        autocomplete="off"
        spellcheck="false"
        {onkeydown}
        {onpaste}
        onblur={() => draft.trim() && commit()}
        {oninput}
      />
    </li>
  </ul>
  {#if problem}<span class="ta-tag-input-problem" id={errorId} role="alert">{problem}</span>{/if}
</div>

<style>
  .ta-tag-input {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .ta-tag-input-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    padding: 0.3125rem 0.5rem;
    list-style: none;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    transition: border-color var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out);
  }

  .ta-tag-input-list:focus-within {
    border-color: rgb(var(--ta-accent));
    box-shadow: 0 0 0 3px rgb(var(--ta-accent) / 0.2);
  }

  .ta-tag-input--disabled .ta-tag-input-list {
    opacity: 0.6;
  }

  .ta-tag-input-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 100%;
    padding: 0.125rem 0.25rem 0.125rem 0.5rem;
    font-size: 0.8125rem;
    font-family: var(--ta-font-mono);
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-text) / 0.06);
    border: 1px solid rgb(var(--ta-border));
    border-radius: 999px;
  }

  .ta-tag-input-text {
    overflow-wrap: anywhere;
  }

  .ta-tag-input-remove {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    color: rgb(var(--ta-text-dim));
    background: transparent;
    border: 0;
    border-radius: 999px;
    cursor: pointer;
  }

  .ta-tag-input-remove:hover:not(:disabled) {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-text) / 0.1);
  }

  .ta-tag-input-remove:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
    outline-offset: 1px;
  }

  /* A 24px target on a fine pointer, around the 20px drawing. */
  .ta-tag-input-remove::after {
    content: "";
    position: absolute;
    inset: -0.125rem;
  }

  .ta-tag-input-entry {
    flex: 1 1 8rem;
    min-width: 6rem;
  }

  .ta-tag-input-field {
    width: 100%;
    padding: 0.25rem 0;
    font: inherit;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
    background: transparent;
    border: 0;
    outline: none;
  }

  .ta-tag-input-field::placeholder {
    color: rgb(var(--ta-text-dim));
  }

  .ta-tag-input-problem {
    font-size: 0.75rem;
    color: rgb(var(--ta-danger));
  }

  @media (pointer: coarse) {
    .ta-tag-input-remove::after {
      inset: -0.75rem;
    }
    .ta-tag-input-field {
      min-height: 2.75rem;
      font-size: 1rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-tag-input-list {
      transition: none;
    }
  }
</style>
