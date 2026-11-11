<!--
  tallao — Toaster
  Where the `toast()` notifications appear. A named region with aria-live:
  a screen reader reads them without moving focus (errors, as an alert).
  Hovering or focusing a notification pauses its countdown (WCAG 2.2.1).
  It sits in the browser's top layer to stay above the rest of the page.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { fade } from "$lib/motion";
  import { cn } from "$lib/utils";
  import { toast, toasts, type Toast } from "$lib/toast.svelte";

  const L = useLabels();
  const {
    position = "bottom-right",
    label = L.notifications,
    dismissLabel = L.dismiss,
    class: className = "",
  }: {
    position?: "top-right" | "top-left" | "bottom-right" | "bottom-left" | "top-center" | "bottom-center";
    /** Name of the region. */
    label?: string;
    dismissLabel?: string;
    class?: string;
  } = $props();

  let region: HTMLElement | undefined = $state();

  // Countdown per notification, pausable.
  const clocks = new Map<number, { remaining: number; since: number; timer?: ReturnType<typeof setTimeout> }>();

  function start(t: Toast) {
    const r = clocks.get(t.id) ?? { remaining: t.duration ?? 5000, since: 0 };
    clocks.set(t.id, r);
    // Already running (focus and pointer leave at the same time), or it never expires.
    if (r.timer || !Number.isFinite(r.remaining)) return;
    r.since = Date.now();
    r.timer = setTimeout(() => toast.dismiss(t.id), r.remaining);
  }

  function pause(t: Toast) {
    const r = clocks.get(t.id);
    if (!r?.timer) return;
    clearTimeout(r.timer);
    r.timer = undefined;
    r.remaining -= Date.now() - r.since;
  }

  // New notifications start their clock; the ones that left release theirs.
  $effect(() => {
    const alive = new Set(toasts.map((t) => t.id));
    for (const t of toasts) if (!clocks.has(t.id)) start(t);
    for (const [id, r] of clocks) {
      if (!alive.has(id)) {
        clearTimeout(r.timer);
        clocks.delete(id);
      }
    }
  });

  // With notifications, the region moves to the top layer (and back to the very top with each new one).
  $effect(() => {
    const r = region;
    const n = toasts.length;
    if (!r || typeof r.showPopover !== "function") return;
    try {
      if (r.matches(":popover-open")) r.hidePopover();
      if (n > 0) r.showPopover();
    } catch {
      // No Popover API: the region stays fixed with its z-index.
    }
  });
</script>

<section
  bind:this={region}
  popover="manual"
  aria-label={label}
  class={cn("ta-toaster", `ta-toaster--${position}`, className)}
>
  <ol class="ta-toaster-list" aria-live="polite">
    {#each toasts as t (t.id)}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <li
        out:fade={{ duration: "base" }}
        class={cn("ta-toast", `ta-toast--${t.variant}`)}
        role={t.variant === "error" ? "alert" : undefined}
        onpointerenter={() => pause(t)}
        onpointerleave={() => start(t)}
        onfocusin={() => pause(t)}
        onfocusout={() => start(t)}
      >
        <div class="ta-toast-body">
          <p class="ta-toast-message">{t.message}</p>
          {#if t.description}<p class="ta-toast-detail">{t.description}</p>{/if}
        </div>
        {#if t.action}
          <button
            type="button"
            class="ta-toast-action"
            onclick={() => {
              t.action?.onClick();
              toast.dismiss(t.id);
            }}>{t.action.label}</button
          >
        {/if}
        <button type="button" class="ta-toast-close" aria-label={dismissLabel} onclick={() => toast.dismiss(t.id)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </li>
    {/each}
  </ol>
</section>

<style>
  .ta-toaster {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 0;
    z-index: 70;
    width: min(24rem, calc(100vw - 2rem));
    background: transparent;
    border: none;
    overflow: visible;
    color: inherit;
  }

  /* Above a BottomNav (it sets --ta-bottom-nav-offset while it is shown) and the safe areas. */
  .ta-toaster {
    --ta-toaster-bottom: calc(1rem + var(--ta-bottom-nav-offset, env(safe-area-inset-bottom, 0px)));
    --ta-toaster-top: calc(1rem + env(safe-area-inset-top, 0px));
  }
  .ta-toaster--bottom-right { right: 1rem; bottom: var(--ta-toaster-bottom); }
  .ta-toaster--bottom-left { left: 1rem; bottom: var(--ta-toaster-bottom); }
  .ta-toaster--top-right { right: 1rem; top: var(--ta-toaster-top); }
  .ta-toaster--top-left { left: 1rem; top: var(--ta-toaster-top); }
  .ta-toaster--top-center { top: var(--ta-toaster-top); left: 50%; transform: translateX(-50%); }
  .ta-toaster--bottom-center { bottom: var(--ta-toaster-bottom); left: 50%; transform: translateX(-50%); }

  .ta-toaster-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ta-toast {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-left-width: 3px;
    border-radius: var(--ta-radius);
    box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.45);
    animation: ta-toast-enter var(--ta-duration-base, 180ms) var(--ta-ease-out, ease-out);
  }

  .ta-toast--success { border-left-color: rgb(var(--ta-success)); }
  .ta-toast--error { border-left-color: rgb(var(--ta-danger)); }
  .ta-toast--warning { border-left-color: rgb(var(--ta-warning)); }
  .ta-toast--info { border-left-color: rgb(var(--ta-info)); }

  .ta-toast-body { flex: 1; min-width: 0; }
  .ta-toast-message { margin: 0; font-size: 0.875rem; font-weight: 500; }
  .ta-toast-detail { margin: 0.125rem 0 0; font-size: 0.8125rem; color: rgb(var(--ta-text-dim)); }

  .ta-toast-action {
    padding: 0.25rem 0.5rem;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    color: rgb(var(--ta-accent-hover));
    background: none;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }

  .ta-toast-close {
    padding: 0.125rem;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-toast-close:hover { color: rgb(var(--ta-text)); }
  .ta-toast-action:focus-visible,
  .ta-toast-close:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }

  @keyframes ta-toast-enter {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-toast { animation: none; }
  }
  @media (pointer: coarse) {
    .ta-toast-action { min-height: 2.75rem; padding: 0.25rem 0.75rem; }
    .ta-toast-close { position: relative; }
    .ta-toast-close::after { content: ""; position: absolute; top: 50%; left: 50%; width: max(100%, 2.75rem); height: max(100%, 2.75rem); transform: translate(-50%, -50%); }
  }
</style>
