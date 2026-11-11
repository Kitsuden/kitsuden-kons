<!--
  tallao — Sheet
  Modal side panel (a record's detail, settings, a cart): it is a
  Dialog attached to an edge, with everything that comes with it (contained focus, Escape,
  locked scroll, focus restored).
-->
<script lang="ts">
  import Dialog from "./dialog.svelte";

  let {
    open = $bindable(false),
    side = "right",
    title = "",
    description,
    size = "lg",
    closeLabel,
    ariaLabel,
    class: className = "",
    onClose,
    children,
    footer,
  }: {
    open?: boolean;
    side?: "left" | "right" | "top" | "bottom";
    title?: string;
    description?: string;
    /** Width of the side panel (does not apply to top or bottom). */
    size?: "sm" | "md" | "lg" | "xl" | "2xl";
    closeLabel?: string;
    ariaLabel?: string;
    class?: string;
    onClose?: () => void;
    children?: import("svelte").Snippet;
    footer?: import("svelte").Snippet;
  } = $props();
</script>

<Dialog
  bind:open
  placement={side}
  {title}
  {description}
  {size}
  {closeLabel}
  {ariaLabel}
  class={className}
  {onClose}
  {children}
  {footer}
/>
