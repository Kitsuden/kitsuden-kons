<!--
  tallao — ConfirmDialog
  A confirmation built on Dialog. `onConfirm` can be async: the button shows
  loading and the dialog only closes if it succeeds (if it throws, it stays open
  and the caller renders the error). Children go between the text and the buttons
  (e.g. where to move what is being deleted).
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";

  import Button from "./button.svelte";
  import Dialog from "./dialog.svelte";

  interface Props {
    open?: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    closeLabel?: string;
    variant?: "primary" | "danger";
    onConfirm: () => void | Promise<void>;
    /** Closed without confirming: Cancel, Escape, the X or a click outside. */
    onCancel?: () => void;
    onOpenChange?: (open: boolean) => void;
    children?: import("svelte").Snippet;
  }

  const L = useLabels();
  let {
    open = $bindable(false),
    title,
    description,
    confirmLabel = L.confirm,
    cancelLabel = L.cancel,
    closeLabel,
    variant = "danger",
    onConfirm,
    onCancel,
    onOpenChange,
    children,
  }: Props = $props();

  let busy = $state(false);
  // A single notice per opening: the Cancel button and the Dialog closing can both arrive.
  let notified = false;
  $effect(() => {
    if (open) notified = false;
  });

  function notifyCancel() {
    if (notified) return;
    notified = true;
    onOpenChange?.(false);
    onCancel?.();
  }

  async function confirm() {
    busy = true;
    try {
      await onConfirm();
      notified = true;
      open = false;
      onOpenChange?.(false);
    } catch {
      // The caller already shows the error; the dialog stays open to retry.
    } finally {
      busy = false;
    }
  }

  function cancel() {
    open = false;
    notifyCancel();
  }
</script>

<!-- Dialog calls onClose only when the user closes it (Escape, the X, the backdrop):
     that is cancelling. Closing it after confirming does not go through there. -->
<Dialog bind:open {title} {description} {closeLabel} size="sm" onClose={notifyCancel}>
  {@render children?.()}
  {#snippet footer()}
    <Button variant="ghost" onclick={cancel} disabled={busy}>{cancelLabel}</Button>
    <Button {variant} loading={busy} onclick={confirm}>{confirmLabel}</Button>
  {/snippet}
</Dialog>
