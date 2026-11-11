<!--
  tallao — Popover
  Floating panel anchored to a trigger: filters, quick settings, a short
  form. It is not modal: the rest of the page stays usable; Escape or a
  click outside closes it and focus returns to the trigger.

  The consumer provides the trigger, with the props the snippet receives:

    <Popover title="Filters">
      {#snippet trigger(props)}<Button {...props}>Filters</Button>{/snippet}
      …content…
    </Popover>
-->
<script lang="ts" module>
  export type TriggerProps = Record<string | symbol, unknown>;
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { createAttachmentKey } from "svelte/attachments";

  import { cn } from "$lib/utils";
  import { restoreFocus, getActiveElement, tabbables } from "$lib/internal/focus";
  import { pushLayer } from "$lib/internal/layers";
  import { anchor, type Placement } from "$lib/internal/position";
  import { scaleIn } from "$lib/motion";

  interface Props {
    open?: boolean;
    placement?: Placement;
    /** Panel title: it is also its accessible name. */
    title?: string;
    /** Accessible name when there is no `title`. */
    ariaLabel?: string;
    class?: string;
    onOpenChange?: (open: boolean) => void;
    trigger: import("svelte").Snippet<[TriggerProps]>;
    children?: import("svelte").Snippet;
  }

  let {
    open = $bindable(false),
    placement = "bottom-start",
    title,
    ariaLabel,
    class: className = "",
    onOpenChange,
    trigger,
    children,
  }: Props = $props();

  const id = $props.id();
  let triggerEl: HTMLElement | null = $state(null);
  let panel: HTMLElement | undefined = $state();

  function setOpen(value: boolean) {
    if (open === value) return;
    open = value;
    onOpenChange?.(value);
  }

  const triggerProps = $derived({
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? `${id}-panel` : undefined,
    onclick: () => setOpen(!open),
    [createAttachmentKey()]: (node: HTMLElement) => {
      triggerEl = node;
      return () => {
        if (triggerEl === node) triggerEl = null;
      };
    },
  });

  $effect(() => {
    const p = panel;
    const a = triggerEl;
    if (!open || !p || !a) return;
    const previous = getActiveElement();
    const release = anchor(a, p, { placement });
    const removeLayer = pushLayer({
      inside: () => [p, a],
      dismiss: (reason) => {
        setOpen(false);
        if (reason === "escape") restoreFocus(a);
      },
    });
    // Focus moves into the panel's first control (or the panel), without tracking dependencies.
    untrack(() => (tabbables(p)[0] ?? p).focus({ preventScroll: true }));
    return () => {
      removeLayer();
      release();
      // If focus was still inside, it returns to the trigger; if the user already moved elsewhere, it does not.
      if (p.contains(getActiveElement())) restoreFocus(previous === a ? a : previous);
    };
  });
</script>

{@render trigger(triggerProps)}

{#if open}
  <div
    bind:this={panel}
    id={`${id}-panel`}
    popover="manual"
    role="dialog"
    tabindex="-1"
    aria-labelledby={title ? `${id}-title` : undefined}
    aria-label={title ? undefined : ariaLabel}
    class={cn("ta-popover", className)}
    out:scaleIn={{ duration: "fast", from: 0.98 }}
  >
    {#if title}<p class="ta-popover-title" id={`${id}-title`}>{title}</p>{/if}
    {@render children?.()}
  </div>
{/if}

<style>
  .ta-popover {
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 50;
    min-width: 12rem;
    max-width: min(24rem, calc(100vw - 1rem));
    padding: 0.75rem 1rem;
    overflow: visible;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.45);
    font: inherit;
    outline: none;
    animation: ta-popover-enter var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out);
  }

  .ta-popover-title {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
  }

  @keyframes ta-popover-enter {
    from { opacity: 0; transform: translateY(-2px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-popover { animation: none; }
  }
</style>
