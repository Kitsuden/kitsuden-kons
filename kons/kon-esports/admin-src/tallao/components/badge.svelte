<!--
  tallao — Badge
  Status and category tags, rounded and with a soft border.
    - `tone="soft"` (default): tinted with the color, with its border.
    - `tone="solid"`: filled with the color and contrasting text, for what has to show
      on top of an image ("LIVE", "NEW"). `default` and `secondary` do not change.
  `accent` is the main accent; `accent-2`, the second one (pink by default).
  `dot` draws a leading dot in the variant's colour (a status: "Published", "Failed"); `pulse`
  makes it pulse for something live or running, except under `prefers-reduced-motion`.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  type Variant =
    | "default"
    | "success"
    | "warning"
    | "error"
    | "info"
    | "purple"
    | "accent"
    | "accent-2"
    | "secondary";
  type Size = "sm" | "md";

  interface Props {
    variant?: Variant;
    size?: Size;
    tone?: "soft" | "solid";
    /** A leading status dot in the variant's colour. */
    dot?: boolean;
    /** The dot pulses (live, running); still under reduced motion. Implies `dot`. */
    pulse?: boolean;
    class?: string;
    children: import("svelte").Snippet;
    /** Any other attribute (title, role, aria-*, data-*, style…) goes to the <span>. */
    [key: string]: unknown;
  }

  const {
    variant = "default",
    size = "sm",
    tone = "soft",
    dot = false,
    pulse = false,
    class: className = "",
    children,
    ...rest
  }: Props = $props();
</script>

<span
  {...rest}
  class={cn("ta-badge", `ta-badge--${variant}`, `ta-badge--${size}`, tone === "solid" && "ta-badge--solid", className)}
>
  {#if dot || pulse}<span class={cn("ta-badge-dot", pulse && "ta-badge-dot--pulse")} aria-hidden="true"></span>{/if}
  {@render children()}
</span>

<style>
  .ta-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-weight: 500;
    border-radius: 9999px;
    border: 1px solid;
    white-space: nowrap;
  }

  .ta-badge--sm { padding: 0.125rem 0.5rem; font-size: 0.75rem; }
  .ta-badge--md { padding: 0.25rem 0.625rem; font-size: 0.875rem; }

  .ta-badge--default {
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-text-dim));
    border-color: rgb(var(--ta-border));
  }
  .ta-badge--secondary {
    background: rgb(var(--ta-elevated));
    color: rgb(var(--ta-text));
    border-color: rgb(var(--ta-muted));
  }
  .ta-badge--success {
    background: rgb(var(--ta-success) / 0.1);
    color: rgb(var(--ta-success));
    border-color: rgb(var(--ta-success) / 0.2);
  }
  .ta-badge--warning {
    background: rgb(var(--ta-warning) / 0.1);
    color: rgb(var(--ta-warning));
    border-color: rgb(var(--ta-warning) / 0.2);
  }
  .ta-badge--error {
    background: rgb(var(--ta-danger) / 0.1);
    color: rgb(var(--ta-danger));
    border-color: rgb(var(--ta-danger) / 0.2);
  }
  .ta-badge--info {
    background: rgb(var(--ta-info) / 0.1);
    color: rgb(var(--ta-info));
    border-color: rgb(var(--ta-info) / 0.2);
  }
  .ta-badge--purple,
  .ta-badge--accent {
    background: rgb(var(--ta-accent) / 0.1);
    color: rgb(var(--ta-accent-hover));
    border-color: rgb(var(--ta-accent) / 0.2);
  }
  .ta-badge--accent-2 {
    background: rgb(var(--ta-accent-2) / 0.1);
    color: rgb(var(--ta-accent-2));
    border-color: rgb(var(--ta-accent-2) / 0.2);
  }

  /* — Solid: the variant's color as background and the text that contrasts with it. Pink
     uses its dark step (--ta-accent-2-dim): with white text it reaches 4.5:1. The `--ta-on-*`
     carry their fallback value because ThemeScope does not define them. — */
  .ta-badge--success { --ta-badge-color: var(--ta-success); --ta-badge-on: var(--ta-on-success, 9 9 11); }
  .ta-badge--warning { --ta-badge-color: var(--ta-warning); --ta-badge-on: var(--ta-on-warning, 9 9 11); }
  .ta-badge--error { --ta-badge-color: var(--ta-danger); --ta-badge-on: var(--ta-on-danger, 9 9 11); }
  .ta-badge--info { --ta-badge-color: var(--ta-info); --ta-badge-on: var(--ta-on-info, 9 9 11); }
  .ta-badge--purple,
  .ta-badge--accent { --ta-badge-color: var(--ta-accent); --ta-badge-on: var(--ta-on-accent); }
  .ta-badge--accent-2 { --ta-badge-color: var(--ta-accent-2-dim); --ta-badge-on: var(--ta-on-accent-2, 255 255 255); }

  /* The accent as a fill is darkened so its text reaches 4.5:1 (see Button). */
  .ta-badge--solid.ta-badge--purple,
  .ta-badge--solid.ta-badge--accent {
    background: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
    border-color: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
  }
  .ta-badge--solid:not(.ta-badge--default, .ta-badge--secondary, .ta-badge--purple, .ta-badge--accent) {
    background: rgb(var(--ta-badge-color));
    color: rgb(var(--ta-badge-on));
    border-color: rgb(var(--ta-badge-color));
    font-weight: 600;
  }

  /* — Status dot: the text colour of the variant, so it follows soft and solid. — */
  .ta-badge-dot {
    position: relative;
    flex-shrink: 0;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: currentColor;
  }
  .ta-badge--md .ta-badge-dot { width: 0.5rem; height: 0.5rem; }
  .ta-badge-dot--pulse::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: currentColor;
    animation: ta-badge-pulse 1.6s ease-out infinite;
  }
  @keyframes ta-badge-pulse {
    from { transform: scale(1); opacity: 0.6; }
    to { transform: scale(2.6); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ta-badge-dot--pulse::after { animation: none; display: none; }
  }
</style>
