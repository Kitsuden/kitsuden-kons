<!--
  tallao — DiffView
  Before and after of a record: a list of field changes, as an audit log or a revision
  history shows them.

    <DiffView changes={[
      { field: "title", label: "Title", before: "Hello", after: "Hello, world" },
      { field: "tags", label: "Tags", before: null, after: ["news"] },
      { field: "excerpt", label: "Excerpt", before: "Old text", after: null },
    ]} />

  - The kind of each change is worked out from the values: no `before` is **added**, no
    `after` is **removed**, different values are **changed**; equal ones are left out unless
    `showUnchanged`. The kind is never colour alone: each one has a sign (+ − ~), a word
    ("Added") and, on the values, `<ins>` / `<del>` with a "+" / "−" in front.
  - Values are plain JSON. Text keeps its line breaks and wraps anywhere (a long URL does not
    widen the page); objects and arrays are printed as indented JSON in monospace; `true`,
    numbers and the rest as text. A value longer than `collapseAfter` characters is folded,
    with a "Show more" button (`aria-expanded`).
  - `compact`: one line per change, "Title: ~~Hello~~ → Hello, world", cut with an ellipsis
    (the whole value is in `title`). For a table cell or a Timeline entry.
  - `format(value, change)` writes a value yourself (a date, a relation's name).
  - `redacted: true` on a change: a secret field (a token, a password) that changed and whose
    values are not known. It is listed as changed, and both sides read `redactedLabel`
    ("hidden") in italics, with no `<del>` / `<ins>` and no strike-through.
  - With no changes it shows `emptyText`. Same HTML on the server.
-->
<script lang="ts" module>
  export interface DiffChange {
    /** The field's key. */
    field: string;
    /** The field's name for people; the key by default. */
    label?: string;
    /** `null`, `undefined` or "" mean "there was nothing". */
    before?: unknown;
    after?: unknown;
    /** A secret that changed: its values are not shown (nor needed), and it counts as changed. */
    redacted?: boolean;
  }

  export type DiffKind = "added" | "removed" | "changed" | "unchanged";

  const blank = (v: unknown) => v === null || v === undefined || v === "";

  /** What happened to a field, from its two values. */
  export function diffKind(change: DiffChange): DiffKind {
    if (change.redacted) return "changed";
    const a = blank(change.before);
    const b = blank(change.after);
    if (a && b) return "unchanged";
    if (a) return "added";
    if (b) return "removed";
    return JSON.stringify(change.before) === JSON.stringify(change.after) ? "unchanged" : "changed";
  }
</script>

<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  interface Props {
    changes: DiffChange[];
    /** One line per change. */
    compact?: boolean;
    /** Also list the fields whose value did not change. */
    showUnchanged?: boolean;
    /** Characters after which a value is folded behind "Show more" (0: never). */
    collapseAfter?: number;
    /** Writes a value yourself; return `undefined` to keep the default. */
    format?: (value: unknown, change: DiffChange) => string | undefined;
    /** Accessible name of the list. */
    ariaLabel?: string;
    beforeLabel?: string;
    afterLabel?: string;
    addedLabel?: string;
    removedLabel?: string;
    changedLabel?: string;
    /** What a missing value is called ("empty"). */
    emptyValueLabel?: string;
    /** What a redacted value reads ("hidden"). */
    redactedLabel?: string;
    showMoreLabel?: string;
    showLessLabel?: string;
    /** Shown when there is nothing to list. */
    emptyText?: string;
    class?: string;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const L = useLabels();
  const {
    changes,
    compact = false,
    showUnchanged = false,
    collapseAfter = 320,
    format,
    ariaLabel = L.changes,
    beforeLabel = L.before,
    afterLabel = L.after,
    addedLabel = L.added,
    removedLabel = L.removed,
    changedLabel = L.changed,
    emptyValueLabel = L.emptyValue,
    redactedLabel = L.redacted,
    showMoreLabel = L.showMore,
    showLessLabel = L.showLess,
    emptyText = L.noChanges,
    class: className = "",
    ...rest
  }: Props = $props();

  const id = $props.id();
  const SIGN: Record<DiffKind, string> = { added: "+", removed: "−", changed: "~", unchanged: "=" };
  const kindLabel = (kind: DiffKind) => (kind === "added" ? addedLabel : kind === "removed" ? removedLabel : kind === "changed" ? changedLabel : "");

  const isStructured = (v: unknown) => typeof v === "object" && v !== null;

  function text(value: unknown, change: DiffChange, pretty: boolean): string {
    const custom = format?.(value, change);
    if (custom !== undefined) return custom;
    if (isStructured(value)) return JSON.stringify(value, null, pretty ? 2 : undefined);
    return String(value);
  }

  const rows = $derived(
    changes
      .map((change) => {
        const kind = diffKind(change);
        return {
          change,
          kind,
          label: change.label ?? change.field,
          redacted: !!change.redacted,
          before: change.redacted || blank(change.before) ? null : text(change.before, change, !compact),
          after: change.redacted || blank(change.after) ? null : text(change.after, change, !compact),
          mono: !change.redacted && (isStructured(change.before) || isStructured(change.after)),
        };
      })
      .filter((row) => showUnchanged || row.kind !== "unchanged")
  );

  let expanded = $state<Record<string, boolean>>({});
  const isLong = (row: { before: string | null; after: string | null }) =>
    collapseAfter > 0 && Math.max(row.before?.length ?? 0, row.after?.length ?? 0) > collapseAfter;
</script>

{#if rows.length === 0}
  <p {...rest} class={cn("ta-diff-empty", className)}>{emptyText}</p>
{:else if compact}
  <ul {...rest} class={cn("ta-diff ta-diff--compact", className)} aria-label={ariaLabel}>
    {#each rows as row (row.change.field)}
      <li class={cn("ta-diff-line", `ta-diff-line--${row.kind}`)}>
        <span class="ta-diff-sign" aria-hidden="true">{SIGN[row.kind]}</span>
        <span class="ta-diff-field">{row.label}<span class="ta-diff-hidden">{" (" + (kindLabel(row.kind) || "=") + ")"}</span>:</span>
        {#if row.redacted}
          <span class="ta-diff-inline ta-diff-redacted">{redactedLabel}</span>
        {:else if row.kind === "unchanged"}
          <span class={cn("ta-diff-inline", row.mono && "ta-diff-mono")} title={row.after ?? ""}>{row.after ?? emptyValueLabel}</span>
        {:else}
          {#if row.before !== null}
            <del class={cn("ta-diff-inline", row.mono && "ta-diff-mono")} title={row.before}><span class="ta-diff-hidden">{beforeLabel + ": "}</span>{row.before}</del>
          {/if}
          {#if row.before !== null && row.after !== null}<span class="ta-diff-arrow" aria-hidden="true">→</span>{/if}
          {#if row.after !== null}
            <ins class={cn("ta-diff-inline", row.mono && "ta-diff-mono")} title={row.after}><span class="ta-diff-hidden">{afterLabel + ": "}</span>{row.after}</ins>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <ul {...rest} class={cn("ta-diff", className)} aria-label={ariaLabel}>
    {#each rows as row, i (row.change.field)}
      {@const long = isLong(row)}
      {@const open = !long || !!expanded[row.change.field]}
      <li class={cn("ta-diff-item", `ta-diff-item--${row.kind}`)}>
        <div class="ta-diff-head">
          <span class="ta-diff-field">{row.label}</span>
          {#if row.kind !== "unchanged"}
            <span class={cn("ta-diff-kind", `ta-diff-kind--${row.kind}`)}>
              <span class="ta-diff-sign" aria-hidden="true">{SIGN[row.kind]}</span>{kindLabel(row.kind)}
            </span>
          {/if}
        </div>
        <div class={cn("ta-diff-values", !open && "ta-diff-values--folded")} id={`${id}-v${i}`}>
          {#if row.kind === "unchanged"}
            <div class="ta-diff-value">
              <span class={cn("ta-diff-text", row.mono && "ta-diff-mono")}>{row.after ?? emptyValueLabel}</span>
            </div>
          {:else if row.redacted}
            <div class="ta-diff-value ta-diff-value--before">
              <span class="ta-diff-side">{beforeLabel}</span>
              <span class="ta-diff-text ta-diff-none ta-diff-redacted">{redactedLabel}</span>
            </div>
            <div class="ta-diff-value ta-diff-value--after">
              <span class="ta-diff-side">{afterLabel}</span>
              <span class="ta-diff-text ta-diff-none ta-diff-redacted">{redactedLabel}</span>
            </div>
          {:else}
            <div class="ta-diff-value ta-diff-value--before">
              <span class="ta-diff-side">{beforeLabel}</span>
              {#if row.before === null}
                <span class="ta-diff-text ta-diff-none">{emptyValueLabel}</span>
              {:else}
                <del class={cn("ta-diff-text", row.mono && "ta-diff-mono")}><span class="ta-diff-mark" aria-hidden="true">−</span>{row.before}</del>
              {/if}
            </div>
            <div class="ta-diff-value ta-diff-value--after">
              <span class="ta-diff-side">{afterLabel}</span>
              {#if row.after === null}
                <span class="ta-diff-text ta-diff-none">{emptyValueLabel}</span>
              {:else}
                <ins class={cn("ta-diff-text", row.mono && "ta-diff-mono")}><span class="ta-diff-mark" aria-hidden="true">+</span>{row.after}</ins>
              {/if}
            </div>
          {/if}
        </div>
        {#if long}
          <button
            type="button"
            class="ta-diff-more"
            aria-expanded={open}
            aria-controls={`${id}-v${i}`}
            aria-label={`${open ? showLessLabel : showMoreLabel}: ${row.label}`}
            onclick={() => (expanded[row.change.field] = !open)}
          >
            {open ? showLessLabel : showMoreLabel}
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .ta-diff {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
  }
  .ta-diff-empty { margin: 0; font-size: 0.875rem; color: rgb(var(--ta-text-dim)); }

  .ta-diff-item {
    min-width: 0;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    overflow: hidden;
  }

  .ta-diff-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.375rem 0.75rem;
    background: rgb(var(--ta-elevated) / 0.4);
    border-bottom: 1px solid rgb(var(--ta-border));
  }
  .ta-diff-field { font-weight: 500; min-width: 0; overflow-wrap: anywhere; }

  .ta-diff-kind {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .ta-diff-sign {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
    border-radius: 0.1875rem;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-muted) / 0.4);
  }
  .ta-diff-kind--added .ta-diff-sign,
  .ta-diff-line--added .ta-diff-sign { color: rgb(var(--ta-text)); background: rgb(var(--ta-success) / 0.3); }
  .ta-diff-kind--removed .ta-diff-sign,
  .ta-diff-line--removed .ta-diff-sign { color: rgb(var(--ta-text)); background: rgb(var(--ta-danger) / 0.3); }
  .ta-diff-kind--changed .ta-diff-sign,
  .ta-diff-line--changed .ta-diff-sign { color: rgb(var(--ta-text)); background: rgb(var(--ta-info) / 0.3); }

  /* Before and after side by side when there is room, stacked when narrow. */
  .ta-diff-values { display: grid; grid-template-columns: minmax(0, 1fr); }
  .ta-diff-values--folded { max-height: 7.5rem; overflow: hidden; mask-image: linear-gradient(#000 60%, transparent); }

  .ta-diff-value { min-width: 0; padding: 0.5rem 0.75rem; }
  .ta-diff-value--before { border-bottom: 1px solid rgb(var(--ta-border)); }
  @container (min-width: 34rem) {
    .ta-diff-values { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ta-diff-value--after { border-left: 1px solid rgb(var(--ta-border)); }
    .ta-diff-value--before { border-bottom: none; }
  }
  .ta-diff-value--before:has(del) { background: rgb(var(--ta-danger) / 0.07); }
  .ta-diff-value--after:has(ins) { background: rgb(var(--ta-success) / 0.07); }

  .ta-diff-side {
    display: block;
    margin-bottom: 0.125rem;
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }

  .ta-diff-text {
    display: block;
    position: relative;
    padding-left: 1.125rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    text-decoration: none;
  }
  .ta-diff-mono { font-family: var(--ta-font-mono); font-size: 0.8125rem; }
  .ta-diff-none { padding-left: 0; font-style: italic; color: rgb(var(--ta-text-dim)); }
  .ta-diff-mark {
    position: absolute;
    left: 0;
    font-family: var(--ta-font-mono);
    font-weight: 700;
    color: rgb(var(--ta-text-dim));
  }
  .ta-diff del.ta-diff-text { text-decoration: line-through; text-decoration-color: rgb(var(--ta-danger) / 0.7); color: rgb(var(--ta-text-dim)); }

  /* Indented JSON is not struck through: the sign, the side and the tint already say it. */
  .ta-diff del.ta-diff-text.ta-diff-mono { text-decoration: none; }

  .ta-diff-more {
    position: relative;
    display: block;
    width: 100%;
    padding: 0.375rem 0.75rem;
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-top: 1px solid rgb(var(--ta-border));
    cursor: pointer;
  }
  .ta-diff-more:hover { color: rgb(var(--ta-text)); background: rgb(var(--ta-elevated) / 0.4); }
  .ta-diff-more:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: -2px; }

  /* — Compact: one line per change — */
  /* No size containment here: in a table cell or a flex row the list keeps its content's width. */
  .ta-diff--compact { container-type: normal; gap: 0.25rem; }
  .ta-diff-line {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    white-space: nowrap;
  }
  .ta-diff-line .ta-diff-field { flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; color: rgb(var(--ta-text-dim)); font-weight: 400; }
  .ta-diff-inline {
    flex: 0 1 auto;
    min-width: 2ch;
    overflow: hidden;
    text-overflow: ellipsis;
    text-decoration: none;
  }
  .ta-diff del.ta-diff-inline { text-decoration: line-through; text-decoration-color: rgb(var(--ta-danger) / 0.7); color: rgb(var(--ta-text-dim)); }
  .ta-diff ins.ta-diff-inline { font-weight: 500; }
  .ta-diff-arrow { flex-shrink: 0; color: rgb(var(--ta-text-dim)); }
  .ta-diff-inline.ta-diff-redacted { font-style: italic; color: rgb(var(--ta-text-dim)); }

  .ta-diff-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  @media (pointer: coarse) {
    /* Indented JSON is not struck through: the sign, the side and the tint already say it. */
  .ta-diff del.ta-diff-text.ta-diff-mono { text-decoration: none; }

  .ta-diff-more { min-height: 2.75rem; }
  }
</style>
