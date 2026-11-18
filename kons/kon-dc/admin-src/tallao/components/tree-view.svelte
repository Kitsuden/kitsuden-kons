<!--
  tallao — TreeView
  A hierarchy you move through and pick from: an outline of a document, a file tree, the parts of a
  configuration. WAI-ARIA APG "Tree View" (single selection): role="tree" with nested role="group"
  lists; each node is a role="treeitem" with aria-level, aria-setsize, aria-posinset, aria-expanded
  (when it has children) and aria-selected.

  Keyboard (one tab stop, roving tabindex): ↓/↑ next and previous visible node; → opens a closed
  node, or moves to its first child; ← closes an open node, or moves to its parent; Home/End first
  and last visible node; Enter or Space selects; * opens every sibling of the focused node; typing
  a letter jumps to the next node whose label starts with it. Clicking selects; clicking the arrow
  only opens or closes.

  `expanded` and `selected` are bindable, so the page can open the path to a node or select it from
  outside. On the server the tree renders with the nodes `expanded` names open and the rest closed.
-->
<script lang="ts" module>
  import type { Snippet } from "svelte";

  export interface TreeNode {
    id: string;
    label: string;
    /** A short second line or trailing text (a type, a count). */
    description?: string;
    /** Text of a small badge after the label. */
    badge?: string;
    /** Tone of the badge. */
    badgeTone?: "default" | "success" | "warning" | "error" | "info";
    disabled?: boolean;
    children?: TreeNode[];
  }
</script>

<script lang="ts">
  import { cn } from "$lib/utils";
  import Badge from "./badge.svelte";

  let {
    items,
    selected = $bindable(null),
    expanded = $bindable([]),
    ariaLabel,
    class: className = "",
    onselect,
    node: nodeSnippet,
    ...rest
  }: {
    items: TreeNode[];
    /** Id of the selected node, or null. */
    selected?: string | null;
    /** Ids of the open nodes. */
    expanded?: string[];
    /** Accessible name of the tree. */
    ariaLabel: string;
    class?: string;
    onselect?: (id: string, node: TreeNode) => void;
    /** Draws a node's content instead of label + description + badge. */
    node?: Snippet<[TreeNode, { level: number; selected: boolean }]>;
    /** Other attributes go to the role="tree" element. */
    [key: string]: unknown;
  } = $props();

  const uid = $props.id();
  let focusedId = $state<string | null>(null);
  let treeEl: HTMLUListElement | undefined = $state();

  interface Row {
    node: TreeNode;
    level: number;
    parent: string | null;
  }

  const isOpen = (id: string) => expanded.includes(id);
  const hasChildren = (n: TreeNode) => !!n.children?.length;

  /** The nodes that can be seen, in order, with their level and parent. */
  const visible = $derived.by(() => {
    const out: Row[] = [];
    const walk = (list: TreeNode[], level: number, parent: string | null) => {
      for (const n of list) {
        out.push({ node: n, level, parent });
        if (hasChildren(n) && isOpen(n.id)) walk(n.children!, level + 1, n.id);
      }
    };
    walk(items, 1, null);
    return out;
  });

  /** The node that takes the tab stop: the focused one, the selected one, or the first. */
  const tabStop = $derived(
    visible.find((r) => r.node.id === focusedId)?.node.id ??
      visible.find((r) => r.node.id === selected)?.node.id ??
      visible[0]?.node.id ??
      null
  );

  const domId = (id: string) => `${uid}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  function focusNode(id: string | null | undefined) {
    if (!id) return;
    focusedId = id;
    queueMicrotask(() =>
      [...(treeEl?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])].find((el) => el.id === domId(id))?.focus()
    );
  }

  function toggle(n: TreeNode, open = !isOpen(n.id)) {
    if (!hasChildren(n)) return;
    expanded = open ? [...new Set([...expanded, n.id])] : expanded.filter((e) => e !== n.id);
  }

  function select(n: TreeNode) {
    if (n.disabled) return;
    selected = n.id;
    focusedId = n.id;
    onselect?.(n.id, n);
  }

  function onkeydown(e: KeyboardEvent, row: Row) {
    const i = visible.findIndex((r) => r.node.id === row.node.id);
    const n = row.node;
    switch (e.key) {
      case "ArrowDown":
        focusNode(visible[i + 1]?.node.id);
        break;
      case "ArrowUp":
        focusNode(visible[i - 1]?.node.id);
        break;
      case "ArrowRight":
        if (!hasChildren(n)) return;
        if (!isOpen(n.id)) toggle(n, true);
        else focusNode(n.children![0].id);
        break;
      case "ArrowLeft":
        if (hasChildren(n) && isOpen(n.id)) toggle(n, false);
        else focusNode(row.parent);
        break;
      case "Home":
        focusNode(visible[0]?.node.id);
        break;
      case "End":
        focusNode(visible.at(-1)?.node.id);
        break;
      case "Enter":
      case " ":
        select(n);
        break;
      case "*": {
        const siblings = visible.filter((r) => r.parent === row.parent && hasChildren(r.node)).map((r) => r.node.id);
        expanded = [...new Set([...expanded, ...siblings])];
        break;
      }
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        const ch = e.key.toLowerCase();
        const order = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
        const hit = order.find((r) => r.node.label.toLowerCase().startsWith(ch));
        if (hit) focusNode(hit.node.id);
        else return;
      }
    }
    e.preventDefault();
  }
</script>

{#snippet branch(list: TreeNode[], level: number, parent: string | null)}
  {#each list as n, i (n.id)}
    {@const open = hasChildren(n) && isOpen(n.id)}
    {@const isSelected = selected === n.id}
    {@const row = { node: n, level, parent }}
    <li
      id={domId(n.id)}
      role="treeitem"
      class={cn("ta-tree-item", isSelected && "ta-tree-item--selected", n.disabled && "ta-tree-item--disabled")}
      aria-level={level}
      aria-setsize={list.length}
      aria-posinset={i + 1}
      aria-expanded={hasChildren(n) ? open : undefined}
      aria-selected={isSelected}
      aria-disabled={n.disabled || undefined}
      tabindex={tabStop === n.id ? 0 : -1}
      onkeydown={(e) => {
        if (e.target === e.currentTarget) onkeydown(e, row);
      }}
      onfocus={(e) => {
        if (e.target === e.currentTarget) focusedId = n.id;
      }}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the treeitem takes the keys) -->
      <div class="ta-tree-row" style={`--ta-tree-level: ${level - 1}`} onclick={() => select(n)}>
        {#if hasChildren(n)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (← and → open and close) -->
          <span
            class={cn("ta-tree-toggle", open && "ta-tree-toggle--open")}
            aria-hidden="true"
            onclick={(e) => {
              e.stopPropagation();
              toggle(n);
              focusNode(n.id);
            }}
          >
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </span>
        {:else}
          <span class="ta-tree-spacer" aria-hidden="true"></span>
        {/if}
        {#if nodeSnippet}
          {@render nodeSnippet(n, { level, selected: isSelected })}
        {:else}
          <span class="ta-tree-label">{n.label}</span>
          {#if n.badge}<Badge variant={n.badgeTone ?? "default"} class="ta-tree-badge">{n.badge}</Badge>{/if}
          {#if n.description}<span class="ta-tree-description">{n.description}</span>{/if}
        {/if}
      </div>
      {#if open}
        <ul role="group" class="ta-tree-group">
          {@render branch(n.children!, level + 1, n.id)}
        </ul>
      {/if}
    </li>
  {/each}
{/snippet}

<ul {...rest} bind:this={treeEl} role="tree" aria-label={ariaLabel} class={cn("ta-tree", className)}>
  {@render branch(items, 1, null)}
</ul>

<style>
  .ta-tree,
  .ta-tree-group {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ta-tree {
    min-width: 0;
    font-size: 0.875rem;
  }

  .ta-tree-item {
    outline: none;
  }

  .ta-tree-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 1.75rem;
    padding: 0.125rem 0.5rem 0.125rem calc(0.25rem + var(--ta-tree-level, 0) * 1rem);
    border-radius: var(--ta-radius-sm, 0.375rem);
    color: rgb(var(--ta-text));
    cursor: pointer;
    user-select: none;
    transition: background-color var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out);
  }

  .ta-tree-row:hover {
    background: rgb(var(--ta-text) / 0.06);
  }

  .ta-tree-item:focus-visible > .ta-tree-row {
    outline: 2px solid rgb(var(--ta-accent));
    outline-offset: -2px;
  }

  .ta-tree-item--selected > .ta-tree-row {
    background: rgb(var(--ta-accent) / 0.14);
    box-shadow: inset 3px 0 0 rgb(var(--ta-accent));
    font-weight: 500;
  }

  .ta-tree-item--disabled > .ta-tree-row {
    opacity: 0.55;
    cursor: default;
  }

  .ta-tree-toggle,
  .ta-tree-spacer {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-tree-toggle svg {
    transition: transform var(--ta-duration-fast, 120ms) var(--ta-ease-out, ease-out);
  }

  .ta-tree-toggle--open svg {
    transform: rotate(90deg);
  }

  .ta-tree-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ta-tree-description {
    margin-left: auto;
    padding-left: 0.5rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    white-space: nowrap;
  }

  :global(.ta-tree-badge) {
    flex: none;
  }

  @media (pointer: coarse) {
    .ta-tree-row {
      min-height: 2.75rem;
    }
    .ta-tree-toggle::after {
      content: "";
      position: absolute;
      inset: -0.875rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-tree-row,
    .ta-tree-toggle svg {
      transition: none;
    }
  }
</style>
