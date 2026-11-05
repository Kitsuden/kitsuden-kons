<!--
  tallao — Field
  Label + control + error. The <label> wraps the control, so the
  association is implicit and there is no need to make up ids.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    label: string;
    /** Error message under the control; it also marks the field. */
    error?: string;
    required?: boolean;
    class?: string;
    children: import("svelte").Snippet;
  }

  const { label, error, required = false, class: className = "", children }: Props = $props();
</script>

<label class={cn("ta-field", error && "ta-field--error", className)}>
  <span class="ta-field-label">
    {label}{#if required}<span class="ta-field-required" aria-hidden="true"> *</span>{/if}
  </span>
  {@render children()}
  {#if error}
    <span class="ta-field-error" role="alert">{error}</span>
  {/if}
</label>

<style>
  .ta-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    min-width: 0;
  }

  .ta-field-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: rgb(var(--ta-text-dim));
  }

  .ta-field-required {
    color: rgb(var(--ta-danger));
  }

  .ta-field-error {
    font-size: 0.75rem;
    color: rgb(var(--ta-danger));
  }

  .ta-field--error :global(input),
  .ta-field--error :global(select),
  .ta-field--error :global(textarea) {
    border-color: rgb(var(--ta-danger) / 0.6);
  }
</style>
