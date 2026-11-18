<!--
  tallao — Avatar
  Photo of a person or agent with fallback initials: if there is no `src`
  or the image fails, the initials remain on a stable color (derived from the
  name, so the same person always gets the same one). `name` is its accessible
  name; with `decorative` it is hidden (when the name is already next to it). An explicit
  `aria-label` replaces the name as accessible name, and any other attribute (`data-testid`,
  `title`…) goes to the root. `initials={1}` draws one letter instead of two.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  const {
    name,
    src,
    size = "md",
    shape = "circle",
    decorative = false,
    /** Corner badge (e.g. "AI" for an agent). */
    badge,
    initials = 2,
    "aria-label": ariaLabel,
    class: className = "",
    ...rest
  }: {
    name: string;
    src?: string | null;
    size?: "sm" | "md" | "lg";
    shape?: "circle" | "square";
    decorative?: boolean;
    badge?: string;
    /** How many initials to draw (default 2). */
    initials?: 1 | 2;
    /** Accessible name; defaults to `name`. */
    "aria-label"?: string;
    class?: string;
    /** Any other attribute (data-*, title, style…) goes to the root <span>. */
    [key: string]: unknown;
  } = $props();

  let failed = $state(false);
  // A new image deserves another try.
  $effect(() => {
    void src;
    failed = false;
  });

  const letters = $derived(
    name
      .trim()
      .split(/\s+/)
      .slice(0, initials)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
  const hue = $derived([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
</script>

<span
  {...rest}
  class={cn("ta-avatar", `ta-avatar--${size}`, `ta-avatar--${shape}`, className)}
  role={decorative ? undefined : "img"}
  aria-label={decorative ? undefined : (ariaLabel ?? name)}
  aria-hidden={decorative ? "true" : undefined}
  style:--ta-avatar-tone={hue}
>
  {#if src && !failed}
    <img {src} alt="" onerror={() => (failed = true)} />
  {:else}
    <span class="ta-avatar-initials" aria-hidden="true">{letters}</span>
  {/if}
  {#if badge}<span class="ta-avatar-badge" aria-hidden="true">{badge}</span>{/if}
</span>

<style>
  .ta-avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: white;
    background: hsl(var(--ta-avatar-tone) 45% 40%);
    font-weight: 600;
    user-select: none;
  }

  .ta-avatar--sm { width: 1.5rem; height: 1.5rem; font-size: 0.625rem; }
  .ta-avatar--md { width: 2.25rem; height: 2.25rem; font-size: 0.8125rem; }
  .ta-avatar--lg { width: 3rem; height: 3rem; font-size: 1rem; }

  .ta-avatar--circle,
  .ta-avatar--circle img { border-radius: 9999px; }
  .ta-avatar--square,
  .ta-avatar--square img { border-radius: var(--ta-radius); }

  .ta-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .ta-avatar-badge {
    position: absolute;
    right: -0.25rem;
    bottom: -0.25rem;
    padding: 0 0.25rem;
    font-size: 0.5625rem;
    line-height: 1rem;
    color: rgb(var(--ta-on-accent));
    background: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
    border: 2px solid rgb(var(--ta-bg));
    border-radius: 9999px;
  }
</style>
