<!--
  tallao — Kbd
  A keyboard shortcut hint: a `<kbd>` with one nested `<kbd>` per key, as HTML asks for a
  combination ("Ctrl" + "K").

    <Kbd keys={["Mod", "K"]} />        ⌘K on a Mac, Ctrl+K elsewhere
    <Kbd keys={["Shift", "Enter"]} />
    <Kbd>Esc</Kbd>                      a single key as content

  - `Mod` is the platform's main modifier: ⌘ on Apple devices, Ctrl on the others. On a Mac
    `Shift`, `Alt` / `Option`, `Ctrl` and `Enter` are drawn with their symbols (⇧ ⌥ ⌃ ↵); a
    symbol is hidden from screen readers and its name is read instead ("Command").
  - `platform="auto"` (default) looks at the browser after mount: the server and the first
    render draw the non-Mac legend, so the HTML is the same on both sides. `"mac"` or
    `"other"` fix it (and render that way on the server).
  - It is a hint, not a control: it does not listen to the keys.
-->
<script lang="ts">
  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  interface Props {
    /** The keys of the combination, in order. `Mod` is ⌘ on a Mac and Ctrl elsewhere. */
    keys?: string[];
    platform?: "auto" | "mac" | "other";
    /** Text between the keys when they are not Mac symbols ("+" by default). */
    separator?: string;
    size?: "sm" | "md";
    class?: string;
    /** A single key as content, instead of `keys`. */
    children?: import("svelte").Snippet;
    /** Any other attribute goes to the outer <kbd>. */
    [key: string]: unknown;
  }

  const L = useLabels();
  const { keys = [], platform = "auto", separator = "+", size = "md", class: className = "", children, ...rest }: Props = $props();

  let detected = $state(false);
  $effect(() => {
    if (platform !== "auto") return;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    detected = /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "");
  });
  const mac = $derived(platform === "mac" || (platform === "auto" && detected));

  interface Cap {
    /** What is drawn on the key. */
    text: string;
    /** The key's name when `text` is a symbol. */
    name?: string;
  }

  function cap(key: string): Cap {
    const k = key.toLowerCase();
    if (mac) {
      if (k === "mod" || k === "cmd" || k === "command" || k === "meta") return { text: "⌘", name: L.keyCommand };
      if (k === "shift") return { text: "⇧", name: L.keyShift };
      if (k === "alt" || k === "option") return { text: "⌥", name: L.keyOption };
      if (k === "ctrl" || k === "control") return { text: "⌃", name: L.keyControl };
      if (k === "enter" || k === "return") return { text: "↵", name: "Enter" };
    }
    if (k === "mod") return { text: "Ctrl" };
    return { text: key };
  }

  const caps = $derived(keys.map(cap));
</script>

<kbd {...rest} class={cn("ta-kbd", `ta-kbd--${size}`, className)}>
  {#if children}
    <kbd class="ta-kbd-key">{@render children()}</kbd>
  {:else}
    {#each caps as c, i (i)}
      {#if i > 0}<span class={cn("ta-kbd-sep", mac && "ta-kbd-hidden")}>{separator}</span>{/if}
      <kbd class="ta-kbd-key">
        {#if c.name}<span aria-hidden="true">{c.text}</span><span class="ta-kbd-hidden">{c.name}</span>{:else}{c.text}{/if}
      </kbd>
    {/each}
  {/if}
</kbd>

<style>
  .ta-kbd {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    font: inherit;
    vertical-align: baseline;
    white-space: nowrap;
  }

  .ta-kbd-key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.375rem;
    height: 1.375rem;
    padding: 0 0.3125rem;
    font-family: var(--ta-font-sans);
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-elevated) / 0.6);
    border: 1px solid rgb(var(--ta-border));
    border-bottom-width: 2px;
    border-radius: var(--ta-radius-sm);
  }
  .ta-kbd--sm .ta-kbd-key { min-width: 1.125rem; height: 1.125rem; padding: 0 0.25rem; font-size: 0.625rem; }

  .ta-kbd-sep { font-size: 0.6875rem; color: rgb(var(--ta-text-dim)); }

  .ta-kbd-hidden {
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
</style>
