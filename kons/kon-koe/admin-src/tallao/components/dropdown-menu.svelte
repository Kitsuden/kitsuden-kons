<!--
  tallao — DropdownMenu
  Action menu for a button (the WAI-ARIA APG "menu button" pattern):
    - Enter, Space or ↓ on the trigger open it with focus on the first
      option; ↑ opens it with focus on the last one.
    - ↑ ↓ go through the options (wrapping around), Home and End jump to the
      ends, a letter jumps to the next option that starts with it.
    - Escape closes it and returns focus to the trigger; Tab closes it.
    - Choosing an option runs it and closes the menu.

    <DropdownMenu label="Project actions">
      {#snippet trigger(props)}<Button {...props}>Actions</Button>{/snippet}
      <MenuItem onSelect={edit}>Edit</MenuItem>
      <MenuSeparator />
      <MenuItem variant="danger" onSelect={remove}>Delete</MenuItem>
    </DropdownMenu>
-->
<script lang="ts">
  import { tick } from "svelte";
  import { createAttachmentKey } from "svelte/attachments";

  import { cn } from "$lib/utils";
  import { restoreFocus } from "$lib/internal/focus";
  import { pushLayer } from "$lib/internal/layers";
  import { focusItem, menuKeyboard, provideMenu } from "$lib/internal/menu";
  import { anchor, type Placement } from "$lib/internal/position";
  import { scaleIn } from "$lib/motion";

  import type { TriggerProps } from "./popover.svelte";

  interface Props {
    /** Accessible name of the menu. */
    label: string;
    open?: boolean;
    placement?: Placement;
    class?: string;
    onOpenChange?: (open: boolean) => void;
    trigger: import("svelte").Snippet<[TriggerProps]>;
    children?: import("svelte").Snippet;
  }

  let {
    label,
    open = $bindable(false),
    placement = "bottom-start",
    class: className = "",
    onOpenChange,
    trigger,
    children,
  }: Props = $props();

  const id = $props.id();
  let triggerEl: HTMLElement | null = $state(null);
  let menuEl: HTMLElement | undefined = $state();

  function setOpen(value: boolean) {
    if (open === value) return;
    open = value;
    onOpenChange?.(value);
  }

  async function openMenu(focus: "first" | "last") {
    setOpen(true);
    await tick();
    // The panel is positioned in an effect; focus waits until it exists.
    focusItem(menuEl, focus === "first" ? 0 : -1);
  }

  function close() {
    setOpen(false);
    restoreFocus(triggerEl);
  }

  provideMenu({ close: close });

  const triggerProps = $derived({
    id: `${id}-button`,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? `${id}-menu` : undefined,
    onclick: () => (open ? setOpen(false) : openMenu("first")),
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu(e.key === "ArrowDown" ? "first" : "last");
      }
    },
    [createAttachmentKey()]: (node: HTMLElement) => {
      triggerEl = node;
      return () => {
        if (triggerEl === node) triggerEl = null;
      };
    },
  });

  const keyboard = menuKeyboard(() => setOpen(false));

  $effect(() => {
    const l = menuEl;
    const a = triggerEl;
    if (!open || !l || !a) return;
    const release = anchor(a, l, { placement });
    const remove = pushLayer({
      inside: () => [l, a],
      dismiss: (reason) => (reason === "escape" ? close() : setOpen(false)),
    });
    return () => {
      remove();
      release();
    };
  });
</script>

{@render trigger(triggerProps)}

{#if open}
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    bind:this={menuEl}
    id={`${id}-menu`}
    role="menu"
    aria-label={label}
    popover="manual"
    class={cn("ta-menu", className)}
    onkeydown={(e) => keyboard(e, menuEl)}
    out:scaleIn={{ duration: "fast", from: 0.98 }}
  >
    {@render children?.()}
  </div>
{/if}

<style>
  .ta-menu {
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 50;
    min-width: 10rem;
    max-width: min(20rem, calc(100vw - 1rem));
    max-height: min(24rem, calc(100vh - 2rem));
    max-height: min(24rem, var(--ta-available-height, calc(100dvh - 2rem)));
    overflow-y: auto;
    padding: 0.25rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.45);
    font: inherit;
    animation: ta-menu-enter var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out);
  }

  @keyframes ta-menu-enter {
    from { opacity: 0; transform: translateY(-2px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-menu { animation: none; }
  }
</style>
