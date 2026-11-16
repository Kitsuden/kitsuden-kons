<!--
  tallao — SearchInput
  Search field: magnifier icon, <input type="search"> and a button to clear it (which returns
  focus to the field). It always has an accessible name: `ariaLabel`, or the `placeholder` if
  none is given (a placeholder alone does not name a field for every screen reader).
  Escape clears the field, as in the browser, also when the kit renders it.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  import Icon from "./icon.svelte";

  const L = useLabels();
  let {
    value = $bindable(""),
    ref = $bindable(),
    placeholder = L.search,
    ariaLabel,
    clearLabel = L.clear,
    size = "md",
    name,
    id,
    disabled = false,
    class: className = "",
    inputClass = "",
    oninput,
    onclear,
    ...rest
  }: {
    value?: string;
    ref?: HTMLInputElement;
    placeholder?: string;
    ariaLabel?: string;
    clearLabel?: string;
    size?: "sm" | "md";
    name?: string;
    id?: string;
    disabled?: boolean;
    class?: string;
    /** Classes for the inner <input> (touch height, font size). */
    inputClass?: string;
    oninput?: (value: string) => void;
    onclear?: () => void;
    [key: string]: unknown;
  } = $props();

  function clear() {
    value = "";
    oninput?.("");
    onclear?.();
    ref?.focus();
  }
</script>

<div class={cn("ta-search", `ta-search--${size}`, disabled && "ta-search--off", className)}>
  <span class="ta-search-icon" aria-hidden="true"><Icon name="search" size={size === "sm" ? 14 : 16} /></span>
  <input
    {...rest}
    bind:this={ref}
    bind:value
    {id}
    {name}
    {placeholder}
    {disabled}
    type="search"
    class={cn("ta-search-field", inputClass)}
    aria-label={ariaLabel ?? placeholder}
    autocomplete="off"
    spellcheck="false"
    oninput={() => oninput?.(value)}
    onkeydown={(e) => {
      if (e.key === "Escape" && value) {
        e.preventDefault();
        clear();
      }
    }}
  />
  {#if value && !disabled}
    <button type="button" class="ta-search-clear" aria-label={clearLabel} onclick={clear}>
      <Icon name="x" size={14} />
    </button>
  {/if}
</div>

<style>
  .ta-search { position: relative; display: flex; align-items: center; min-width: 0; }
  .ta-search--off { opacity: 0.5; }
  .ta-search-icon {
    position: absolute;
    left: 0.625rem;
    display: inline-flex;
    color: rgb(var(--ta-text-dim));
    pointer-events: none;
  }
  .ta-search-field {
    width: 100%;
    padding: 0.5rem 2rem 0.5rem 2.125rem;
    font-family: inherit;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .ta-search--sm .ta-search-field { padding: 0.3125rem 1.75rem 0.3125rem 1.875rem; font-size: 0.8125rem; }
  .ta-search--sm .ta-search-icon { left: 0.5rem; }
  .ta-search-field::placeholder { color: rgb(var(--ta-text-dim)); }
  .ta-search-field:focus { border-color: rgb(var(--ta-accent) / 0.5); box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15); }
  .ta-search-field:disabled { cursor: not-allowed; }
  /* The browser's X is redundant: there is a dedicated button. */
  .ta-search-field::-webkit-search-cancel-button { -webkit-appearance: none; display: none; }

  .ta-search-clear {
    position: absolute;
    right: 0.375rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-search-clear:hover { color: rgb(var(--ta-text)); background: rgb(var(--ta-elevated)); }
  .ta-search-clear:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 1px; }

  /* On touch screens: 16px so iOS does not zoom the page on focus, and 44px tall for a finger. */
  @media (pointer: coarse) {
    .ta-search-field { font-size: 1rem; min-height: 2.75rem; }
  }
</style>
