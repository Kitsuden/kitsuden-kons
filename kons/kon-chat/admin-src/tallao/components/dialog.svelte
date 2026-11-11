<!--
  tallao — Dialog
  Modal dialog built on the native <dialog> with showModal(): the browser makes
  the rest of the page inert (Tab does not leave the dialog), puts it in the top
  layer (no z-index fights, also inside a Shadow DOM) and Escape closes only the
  topmost one. tallao adds scroll locking, closing on the backdrop, initial
  focus and returning focus on close.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";
  import { restoreFocus, getActiveElement, tabbables } from "$lib/internal/focus";
  import { lockScroll } from "$lib/internal/scroll-lock";

  interface Props {
    open?: boolean;
    title?: string;
    description?: string;
    size?: "sm" | "md" | "lg" | "xl" | "2xl";
    showClose?: boolean;
    /** Accessible name of the close button. */
    closeLabel?: string;
    /** Accessible name when there is no `title`. */
    ariaLabel?: string;
    /** Heading level of the title (h2 by default: the dialog is its own context). */
    /** Without `title`, still show the X (in the corner). */
    showCloseAlone?: boolean;
    /** No frame or padding: the content brings its own. */
    bare?: boolean;
    titleLevel?: 1 | 2 | 3 | 4 | 5 | 6;
    /** Close on a click outside the panel (yes by default). */
    closeOnBackdrop?: boolean;
    /** Centred, or attached to an edge of the window (this is what Sheet uses). */
    placement?: "center" | "left" | "right" | "top" | "bottom";
    class?: string;
    onClose?: () => void;
    onOpenChange?: (v: boolean) => void;
    children?: import("svelte").Snippet;
    footer?: import("svelte").Snippet;
  }

  const L = useLabels();
  let {
    open = $bindable(false),
    title = "",
    description,
    size = "md",
    showClose = true,
    closeLabel = L.close,
    ariaLabel,
    titleLevel = 2,
    showCloseAlone = false,
    bare = false,
    closeOnBackdrop = true,
    placement = "center",
    class: className = "",
    onClose,
    onOpenChange,
    children,
    footer,
  }: Props = $props();

  const id = $props.id();
  let dialogEl: HTMLDialogElement | undefined = $state();
  let bodyEl: HTMLElement | undefined = $state();

  const widths = { sm: "24rem", md: "28rem", lg: "32rem", xl: "36rem", "2xl": "48rem" };

  function close() {
    if (!open) return;
    open = false;
    onOpenChange?.(false);
    onClose?.();
  }

  /** `autofocus` if there is one; otherwise the first control in the content; otherwise the panel. */
  function focusInitial(d: HTMLDialogElement) {
    const marked = d.querySelector<HTMLElement>("[autofocus]");
    const target = marked ?? (bodyEl && tabbables(bodyEl)[0]) ?? tabbables(d)[0] ?? d.querySelector<HTMLElement>(".ta-dialog");
    target?.focus({ preventScroll: true });
  }

  $effect(() => {
    const d = dialogEl;
    if (!d || !open) return;
    const previous = getActiveElement();
    if (!d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    }
    const unlock = lockScroll();
    // Without tracking dependencies: if `bodyEl` arrives later, the effect must not reopen.
    untrack(() => focusInitial(d));
    return () => {
      unlock();
      if (d.open) {
        if (typeof d.close === "function") d.close();
        else d.removeAttribute("open");
      }
      restoreFocus(previous);
    };
  });

  // Escape: the browser fires `cancel` on the topmost dialog. Its own closing is
  // cancelled so the state (`open`) is in charge and focus is returned.
  function handleCancel(e: Event) {
    e.preventDefault();
    close();
  }

  // A click on the <dialog> itself (outside the panel) is a click on the backdrop.
  function handleClick(e: MouseEvent) {
    if (closeOnBackdrop && e.target === e.currentTarget) close();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialogEl}
  class="ta-dialog-overlay"
  data-placement={placement}
  aria-labelledby={title ? `${id}-title` : undefined}
  aria-describedby={title && description ? `${id}-description` : undefined}
  aria-label={title ? undefined : ariaLabel}
  oncancel={handleCancel}
  onclose={close}
  onclick={handleClick}
>
  {#if open}
    <div
      class={cn("ta-dialog", bare && "ta-dialog--bare", className)}
      style:max-width={placement === "top" || placement === "bottom" ? undefined : widths[size]}
      tabindex="-1"
    >
      {#if !title && showClose && showCloseAlone}
        <button type="button" class="ta-dialog-close ta-dialog-close--floating" onclick={close} aria-label={closeLabel}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      {/if}
      {#if title}
        <div class="ta-dialog-header">
          <div>
            <svelte:element this={`h${titleLevel}`} class="ta-dialog-title" id={`${id}-title`}>{title}</svelte:element>
            {#if description}
              <p class="ta-dialog-description" id={`${id}-description`}>{description}</p>
            {/if}
          </div>
          {#if showClose}
            <button type="button" class="ta-dialog-close" onclick={close} aria-label={closeLabel}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          {/if}
        </div>
      {/if}

      <div class="ta-dialog-body" bind:this={bodyEl}>
        {@render children?.()}
      </div>

      {#if footer}
        <div class="ta-dialog-footer">
          {@render footer()}
        </div>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  /* The <dialog> fills the whole window and centres the panel; its ::backdrop is the backdrop. */
  .ta-dialog-overlay {
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 1rem;
    border: none;
    background: transparent;
    color: inherit;
    overflow: hidden;
  }

  .ta-dialog-overlay[open] {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ta-dialog-overlay[open][data-placement="left"] { justify-content: flex-start; padding: 0; }
  .ta-dialog-overlay[open][data-placement="right"] { justify-content: flex-end; padding: 0; }
  .ta-dialog-overlay[open][data-placement="top"] { align-items: flex-start; padding: 0; }
  .ta-dialog-overlay[open][data-placement="bottom"] { align-items: flex-end; padding: 0; }

  /* Attached to an edge: takes the full height (or width) with no corners on that side. */
  [data-placement="left"] .ta-dialog,
  [data-placement="right"] .ta-dialog {
    height: 100%;
    max-height: none;
    border-radius: 0;
  }
  [data-placement="top"] .ta-dialog,
  [data-placement="bottom"] .ta-dialog {
    max-height: 85vh;
    max-height: 85dvh;
    border-radius: 0;
  }
  [data-placement="left"] .ta-dialog { animation-name: ta-dialog-left; border-left: none; }
  [data-placement="right"] .ta-dialog { animation-name: ta-dialog-right; border-right: none; }
  [data-placement="top"] .ta-dialog { animation-name: ta-dialog-top; border-top: none; }
  [data-placement="bottom"] .ta-dialog { animation-name: ta-dialog-bottom; border-bottom: none; }
  [data-placement="left"] .ta-dialog-body,
  [data-placement="right"] .ta-dialog-body { flex: 1; }

  @keyframes ta-dialog-left { from { transform: translateX(-100%); } to { transform: none; } }
  @keyframes ta-dialog-right { from { transform: translateX(100%); } to { transform: none; } }
  @keyframes ta-dialog-top { from { transform: translateY(-100%); } to { transform: none; } }
  @keyframes ta-dialog-bottom { from { transform: translateY(100%); } to { transform: none; } }

  .ta-dialog-overlay::backdrop {
    background: rgb(var(--ta-backdrop, 0 0 0) / 0.7);
    backdrop-filter: blur(4px);
  }

  .ta-dialog {
    position: relative;
    width: 100%;
    /* A long form scrolls inside; header and footer stay in view. */
    max-height: calc(100vh - 2rem);
    /* dvh: the visible height, with the on-screen keyboard and the browser bars. */
    max-height: calc(100dvh - 2rem);
    display: flex;
    flex-direction: column;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5);
    animation: ta-dialog-enter 0.15s ease-out;
    outline: none;
  }

  @keyframes ta-dialog-enter {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-dialog { animation: none; }
  }

  .ta-dialog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid rgb(var(--ta-border));
  }

  .ta-dialog-title {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 1.125rem;
    font-weight: 600;
    color: rgb(var(--ta-text));
  }

  .ta-dialog-description {
    margin: 0.25rem 0 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-dialog-close {
    padding: 0.25rem;
    background: none;
    border: none;
    color: rgb(var(--ta-text-dim));
    cursor: pointer;
    border-radius: var(--ta-radius-sm);
    transition: color 0.2s;
  }
  .ta-dialog-close:hover { color: rgb(var(--ta-text)); }
  /* Without a title, the X sits alone in the corner, over the content. */
  .ta-dialog-close--floating { position: absolute; top: 0.75rem; right: 0.75rem; z-index: 1; background: rgb(var(--ta-surface) / 0.85); }
  /* Panel with no frame or padding, for content that brings its own (a certificate, an image). */
  .ta-dialog--bare { padding: 0; background: transparent; border: none; box-shadow: none; }
  .ta-dialog--bare :global(.ta-dialog-body) { padding: 0; }
  .ta-dialog-close:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }

  .ta-dialog-body { padding: 1rem 1.5rem; overflow-y: auto; }

  .ta-dialog-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid rgb(var(--ta-border));
  }
  /* Phones: less padding, a footer that wraps, the panel never wider than the screen. */
  @media (max-width: 480px) {
    .ta-dialog-overlay { padding: 0.5rem; }
    .ta-dialog { max-width: 100%; }
    .ta-dialog-header,
    .ta-dialog-body,
    .ta-dialog-footer { padding-left: 1rem; padding-right: 1rem; }
    .ta-dialog-footer { flex-wrap: wrap; }
  }

  @media (pointer: coarse) {
    .ta-dialog-close { display: inline-flex; align-items: center; justify-content: center; min-width: 2.75rem; min-height: 2.75rem; margin: -0.5rem -0.5rem -0.5rem 0; }
    .ta-dialog-close--floating { margin: 0; top: 0.25rem; right: 0.25rem; }
  }
</style>
