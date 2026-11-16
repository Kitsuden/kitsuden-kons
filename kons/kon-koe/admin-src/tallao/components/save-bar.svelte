<!--
  tallao — SaveBar
  The footer of a form: what state it is in and the buttons that end it.

    <form id="post" method="POST">… <SaveBar form="post" {dirty} {saving} onCancel={back}
      secondaryActions={[
        { id: "add", label: "Save and add another", name: "_next", value: "add" },
        { id: "continue", label: "Save and continue editing", name: "_next", value: "continue" },
      ]} /></form>

  - State, in words and with a dot (never colour alone): "Unsaved changes" while `dirty`,
    "Saving…" while `saving`, `error` when the save failed, `savedText` otherwise (nothing by
    default). The text lives in a polite live region that is always in the DOM, so each change
    is announced once and does not interrupt.
  - Buttons, in order: Cancel (`onCancel`, or a link with `cancelHref`), the secondary actions,
    and the primary Save last. Save is a submit button: inside a `<form>` (or pointing at one
    with `form`) it submits it, also without JavaScript; each secondary action submits too,
    with its `name` / `value` so the server knows which one was pressed. `onSave` and each
    action's `onSelect` run on click for forms handled in the browser.
  - `saving` shows Save busy and disables every button; `disableWhenClean` also disables the
    save buttons until there is something to save.
  - It does not cover the form: `sticky` (default) keeps it in the flow as `position: sticky`
    at the bottom of its scrolling container, so its own height is always reserved under the
    last field, above the safe area and above a BottomNav (`--ta-bottom-nav-offset`).
    `sticky={false}` leaves it as a plain footer.
-->
<script lang="ts" module>
  export interface SaveBarAction {
    id: string;
    label: string;
    /** Submitted with the form, so the server knows which button was pressed. */
    name?: string;
    value?: string;
    onSelect?: (event: MouseEvent) => void;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  import Button from "./button.svelte";

  interface Props {
    /** The form has changes that are not saved. */
    dirty?: boolean;
    /** The save is running. */
    saving?: boolean;
    /** The save failed: this text replaces the state. */
    error?: string;
    /** What the bar says when there is nothing to save ("Saved 2 minutes ago"). */
    savedText?: string;
    /** The id of the `<form>` the buttons submit, when the bar is outside it. */
    form?: string;
    /** Other ways of saving, between Cancel and Save. */
    secondaryActions?: SaveBarAction[];
    /** Save (and the secondary actions) cannot be pressed until `dirty`. */
    disableWhenClean?: boolean;
    sticky?: boolean;
    saveLabel?: string;
    cancelLabel?: string;
    dirtyText?: string;
    savingText?: string;
    /** Accessible name of the bar. */
    ariaLabel?: string;
    onSave?: (event: MouseEvent) => void;
    /** Shows Cancel as a button. */
    onCancel?: () => void;
    /** Shows Cancel as a link (back to the list). */
    cancelHref?: string;
    class?: string;
    /** Extra content on the left, after the state (a "Delete" button, a note). */
    children?: Snippet;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const L = useLabels();
  const {
    dirty = false,
    saving = false,
    error,
    savedText = "",
    form,
    secondaryActions = [],
    disableWhenClean = false,
    sticky = true,
    saveLabel = L.submit,
    cancelLabel = L.cancel,
    dirtyText = L.unsavedChanges,
    savingText = L.saving,
    ariaLabel = L.formActions,
    onSave,
    onCancel,
    cancelHref,
    class: className = "",
    children,
    ...rest
  }: Props = $props();

  const phase = $derived(saving ? "saving" : error ? "error" : dirty ? "dirty" : "clean");
  const text = $derived(saving ? savingText : error ? error : dirty ? dirtyText : savedText);
  const locked = $derived(saving || (disableWhenClean && !dirty));
</script>

<div
  {...rest}
  class={cn("ta-save-bar", `ta-save-bar--${phase}`, sticky && "ta-save-bar--sticky", className)}
  role="group"
  aria-label={ariaLabel}
  data-state={phase}
>
  <div class="ta-save-bar-state">
    <span class={cn("ta-save-bar-dot", !text && "ta-save-bar-dot--off")} aria-hidden="true"></span>
    <span class="ta-save-bar-text" role="status" aria-live="polite">{text}</span>
    {@render children?.()}
  </div>
  <div class="ta-save-bar-actions">
    {#if onCancel || cancelHref}
      <Button variant="ghost" href={cancelHref} disabled={saving} onclick={onCancel}>{cancelLabel}</Button>
    {/if}
    {#each secondaryActions as action (action.id)}
      <Button variant="secondary" type="submit" {form} name={action.name} value={action.value} disabled={locked} onclick={action.onSelect}>
        {action.label}
      </Button>
    {/each}
    <Button variant="primary" type="submit" {form} loading={saving} disabled={locked} onclick={onSave}>{saveLabel}</Button>
  </div>
</div>

<style>
  .ta-save-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    min-width: 0;
    margin-top: 1.5rem;
    padding: 0.75rem 1rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }

  /* Sticky, not fixed: the bar keeps its place in the flow, so it never sits on a field. */
  /* The same distance is kept as a bottom margin: at the end of the scroll the bar rests in
     its own slot instead of being pushed up over the last field. */
  .ta-save-bar--sticky {
    --ta-save-bar-gap: calc(var(--ta-bottom-nav-offset, env(safe-area-inset-bottom, 0px)) + 0.75rem);
    position: sticky;
    bottom: var(--ta-save-bar-gap);
    margin-bottom: var(--ta-save-bar-gap);
    z-index: 5;
    box-shadow: 0 -1px 0 rgb(var(--ta-bg)), 0 10px 30px -12px rgb(0 0 0 / 0.45);
  }
  .ta-save-bar--dirty { border-color: rgb(var(--ta-warning) / 0.5); }
  .ta-save-bar--error { border-color: rgb(var(--ta-danger) / 0.6); }

  .ta-save-bar-state {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-width: 0;
    min-height: 1.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }
  .ta-save-bar--dirty .ta-save-bar-text,
  .ta-save-bar--error .ta-save-bar-text { color: rgb(var(--ta-text)); font-weight: 500; }

  .ta-save-bar-dot {
    flex-shrink: 0;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: rgb(var(--ta-success));
  }
  .ta-save-bar-dot--off { display: none; }
  /* A different shape per state, besides the colour. */
  .ta-save-bar--dirty .ta-save-bar-dot { background: rgb(var(--ta-warning)); box-shadow: 0 0 0 3px rgb(var(--ta-warning) / 0.25); }
  .ta-save-bar--error .ta-save-bar-dot { background: rgb(var(--ta-danger)); border-radius: 1px; transform: rotate(45deg); }
  .ta-save-bar--saving .ta-save-bar-dot {
    background: none;
    border: 2px solid rgb(var(--ta-text-dim));
    border-right-color: transparent;
    width: 0.75rem;
    height: 0.75rem;
    animation: ta-save-bar-spin 0.7s linear infinite;
  }
  @keyframes ta-save-bar-spin {
    to { transform: rotate(360deg); }
  }

  .ta-save-bar-text { min-width: 0; overflow-wrap: anywhere; }

  .ta-save-bar-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-left: auto;
  }

  /* A phone: the buttons take a row of their own and share it. */
  @media (max-width: 480px) {
    .ta-save-bar { padding: 0.625rem 0.75rem; }
    .ta-save-bar-actions { width: 100%; }
    .ta-save-bar-actions > :global(.ta-btn) { flex: 1 1 auto; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-save-bar--saving .ta-save-bar-dot { animation: none; }
  }
</style>
