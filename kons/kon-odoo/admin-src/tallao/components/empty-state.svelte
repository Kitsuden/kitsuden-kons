<!--
  tallao — EmptyState
  What a list, a table or a page shows instead of its content. One component, three cases:

  - `variant="empty"` (default), "nothing yet": an icon, a title, a line of text and the
    primary action that creates the first item (`actionLabel` + `onAction` or `actionHref`).
  - `variant="no-results"`, the filters leave nothing: `onClearFilters` adds the
    "Clear filters" button. It is a `role="status"`, so the change is announced politely.
  - `variant="error"`, the load failed: `description` carries the message and `onRetry` adds
    "Retry" (`retrying` shows it busy). It is a `role="alert"`.

    <EmptyState title="No posts yet" description="Write the first one." actionLabel="New post" onAction={create} />
    <EmptyState variant="no-results" onClearFilters={clear} />
    <EmptyState variant="error" description={error.message} onRetry={load} />

  The title is a heading (`level`, h3 by default; `level={null}` for a paragraph); without `title` each variant has its own
  default text. The icon is decorative: the case is always said in words. `actions` replaces
  the buttons, `children` adds content under the text. Same HTML on the server.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "$lib/i18n";
  import { cn } from "$lib/utils";

  import Button from "./button.svelte";
  import Icon, { type IconName } from "./icon.svelte";

  interface Props {
    variant?: "empty" | "no-results" | "error";
    /** By default: "Nothing here yet", "No results for these filters", "Something went wrong". */
    title?: string;
    description?: string;
    /** A kit icon by name, your own drawing as a snippet, or `false` for none. */
    icon?: IconName | Snippet | false;
    /** Heading level of the title; `null` makes it a plain paragraph (inside a table cell). */
    level?: 1 | 2 | 3 | 4 | 5 | 6 | null;
    /** `sm`: inside a table or a card; `md`: a page or a panel of its own. */
    size?: "sm" | "md";
    /** The primary action ("New post"): a button with `onAction`, a link with `actionHref`. */
    actionLabel?: string;
    onAction?: () => void;
    actionHref?: string;
    /** Adds the "Clear filters" button. */
    onClearFilters?: () => void;
    clearFiltersLabel?: string;
    /** Adds the "Retry" button. */
    onRetry?: () => void;
    retryLabel?: string;
    /** The retry is running: the button shows it and cannot be pressed again. */
    retrying?: boolean;
    class?: string;
    /** Your own buttons, instead of the ones above. */
    actions?: Snippet;
    /** Extra content under the description. */
    children?: Snippet;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const L = useLabels();
  const {
    variant = "empty",
    title,
    description,
    icon,
    level = 3,
    size = "md",
    actionLabel,
    onAction,
    actionHref,
    onClearFilters,
    clearFiltersLabel = L.clearFilters,
    onRetry,
    retryLabel = L.retry,
    retrying = false,
    class: className = "",
    actions,
    children,
    ...rest
  }: Props = $props();

  const defaults = $derived(
    variant === "error"
      ? { title: L.errorTitle, icon: "alert" as IconName }
      : variant === "no-results"
        ? { title: L.noResultsTitle, icon: "search" as IconName }
        : { title: L.emptyTitle, icon: "info" as IconName }
  );
  const shownIcon = $derived(icon === false ? null : (icon ?? defaults.icon));
  const hasAction = $derived(!!actionLabel && (!!onAction || !!actionHref));
  const hasButtons = $derived(hasAction || !!onClearFilters || !!onRetry);
</script>

<div
  {...rest}
  class={cn("ta-empty", `ta-empty--${variant}`, `ta-empty--${size}`, className)}
  role={variant === "error" ? "alert" : variant === "no-results" ? "status" : undefined}
>
  {#if shownIcon}
    <span class="ta-empty-icon" aria-hidden="true">
      {#if typeof shownIcon === "function"}{@render shownIcon()}{:else}<Icon name={shownIcon} size={size === "sm" ? 18 : 22} />{/if}
    </span>
  {/if}
  <svelte:element this={level ? `h${level}` : "p"} class="ta-empty-title">{title ?? defaults.title}</svelte:element>
  {#if description}<p class="ta-empty-text">{description}</p>{/if}
  {@render children?.()}
  {#if actions}
    <div class="ta-empty-actions">{@render actions()}</div>
  {:else if hasButtons}
    <div class="ta-empty-actions">
      {#if onRetry}
        <Button variant="secondary" size="sm" loading={retrying} onclick={onRetry}>{retryLabel}</Button>
      {/if}
      {#if onClearFilters}
        <Button variant="secondary" size="sm" onclick={onClearFilters}>{clearFiltersLabel}</Button>
      {/if}
      {#if hasAction}
        <Button variant="primary" size="sm" href={actionHref} onclick={onAction}>{actionLabel}</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ta-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    max-width: 100%;
    padding: 2.5rem 1.5rem;
    text-align: center;
    color: rgb(var(--ta-text-dim));
  }
  .ta-empty--sm { padding: 1.25rem 1rem; }

  .ta-empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    margin-bottom: 0.375rem;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-elevated) / 0.6);
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }
  .ta-empty--sm .ta-empty-icon { width: 2.25rem; height: 2.25rem; }
  .ta-empty--error .ta-empty-icon {
    color: rgb(var(--ta-danger));
    background: rgb(var(--ta-danger) / 0.1);
    border-color: rgb(var(--ta-danger) / 0.3);
  }
  .ta-empty-icon > :global(svg) { width: 1.375rem; height: 1.375rem; }

  .ta-empty-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.35;
    color: rgb(var(--ta-text));
  }
  .ta-empty--sm .ta-empty-title { font-size: 0.875rem; }

  .ta-empty-text {
    margin: 0;
    max-width: 28rem;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .ta-empty--sm .ta-empty-text { font-size: 0.8125rem; }

  .ta-empty-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
</style>
