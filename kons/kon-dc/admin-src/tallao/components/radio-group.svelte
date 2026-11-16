<!--
  tallao — RadioGroup
  Choose one option among a few, all visible. They are native <input type="radio">
  inside a <fieldset> with its <legend>: the browser already provides the
  arrows between options, a single Tab stop for the group and the right announcement.
-->
<script lang="ts" module>
  export interface RadioOption {
    value: string;
    label: string;
    /** Detail line below the label. */
    description?: string;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    options,
    value = $bindable(""),
    legend,
    /** Hides the legend visually (it is still the group's name for a screen reader). */
    hideLegend = false,
    orientation = "vertical",
    name,
    disabled = false,
    required = false,
    class: className = "",
    onchange,
  }: {
    options: RadioOption[];
    value?: string;
    legend: string;
    hideLegend?: boolean;
    orientation?: "vertical" | "horizontal";
    name?: string;
    disabled?: boolean;
    required?: boolean;
    class?: string;
    onchange?: (value: string) => void;
  } = $props();

  const id = $props.id();
  const groupName = $derived(name ?? `ta-radio-${id}`);
</script>

<fieldset class={cn("ta-radio", `ta-radio--${orientation}`, className)} {disabled}>
  <legend class="ta-radio-legend" class:ta-hidden={hideLegend}>{legend}</legend>
  {#each options as o (o.value)}
    <div class="ta-radio-option" class:ta-radio-option--off={o.disabled || disabled}>
      <!-- The detail goes outside the label: otherwise it is added to the option's name. -->
      <input
        id={`${id}-${o.value}`}
        type="radio"
        name={groupName}
        value={o.value}
        bind:group={value}
        disabled={o.disabled}
        {required}
        aria-describedby={o.description ? `${id}-${o.value}-detail` : undefined}
        onchange={() => onchange?.(o.value)}
      />
      <span class="ta-radio-text">
        <label for={`${id}-${o.value}`}>{o.label}</label>
        {#if o.description}<span class="ta-radio-description" id={`${id}-${o.value}-detail`}>{o.description}</span>{/if}
      </span>
    </div>
  {/each}
</fieldset>

<style>
  .ta-radio {
    display: flex;
    gap: 0.5rem 1.25rem;
    margin: 0;
    padding: 0;
    border: none;
    min-width: 0;
  }

  .ta-radio--vertical { flex-direction: column; }
  .ta-radio--horizontal { flex-direction: row; flex-wrap: wrap; }

  .ta-radio-legend {
    padding: 0;
    margin-bottom: 0.375rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: rgb(var(--ta-text-dim));
  }

  /* Visually hidden, accessible to screen readers. */
  .ta-hidden {
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

  .ta-radio-option {
    display: inline-flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
  }

  .ta-radio-option label,
  .ta-radio-option input {
    cursor: pointer;
  }

  .ta-radio-option input {
    width: 1rem;
    height: 1rem;
    margin: 0.125rem 0 0;
    accent-color: rgb(var(--ta-accent));
  }

  .ta-radio-option input:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-radio-text {
    display: flex;
    flex-direction: column;
  }

  .ta-radio-description {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-radio-option--off {
    opacity: 0.5;
  }
  .ta-radio-option--off label,
  .ta-radio-option--off input {
    cursor: not-allowed;
  }

  /* On touch screens: each option is 44px tall for the finger. */
  @media (pointer: coarse) {
    .ta-radio-option { min-height: 2.75rem; align-items: center; }
  }
</style>
