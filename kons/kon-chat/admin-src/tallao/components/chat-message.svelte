<!--
  ChatMessage: one message in a conversation, with who said it and its text.

  For reading conversations (a history, a bot test) alongside PromptInput and
  ToolCallCard. The text keeps line breaks and is not interpreted as HTML. `pending` marks it
  as "typing" (`aria-busy`) while the reply arrives; `footer` holds what accompanies the
  message: sources, tools used, a time.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  type Role = "user" | "assistant" | "system";

  interface Props {
    role?: Role;
    /** Who is speaking; defaults to the role in English ("You", "Assistant", "System"). */
    author?: string;
    /** The message text; `children` replaces it if markup is needed. */
    content?: string;
    /** While the reply arrives: animated dots and `aria-busy`. */
    pending?: boolean;
    /** Accessible name of the waiting indicator. */
    pendingLabel?: string;
    class?: string;
    children?: import("svelte").Snippet;
    footer?: import("svelte").Snippet;
  }

  const {
    role = "assistant",
    author,
    content = "",
    pending = false,
    pendingLabel = "Writing…",
    class: className = "",
    children,
    footer,
  }: Props = $props();

  const defaults: Record<Role, string> = { user: "You", assistant: "Assistant", system: "System" };
  const speaker = $derived(author ?? defaults[role]);
  const id = $props.id();
</script>

<article
  class={cn("ta-chatmsg", `ta-chatmsg--${role}`, className)}
  aria-labelledby={`${id}-author`}
  aria-busy={pending || undefined}
>
  <header class="ta-chatmsg-author" id={`${id}-author`}>{speaker}</header>
  <div class="ta-chatmsg-body">
    {#if pending}
      <span class="ta-chatmsg-typing" role="status" aria-label={pendingLabel}>
        <span></span><span></span><span></span>
      </span>
    {:else if children}
      {@render children()}
    {:else}
      {content}
    {/if}
  </div>
  {#if footer && !pending}
    <footer class="ta-chatmsg-footer">{@render footer()}</footer>
  {/if}
</article>

<style>
  .ta-chatmsg {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: min(42rem, 90%);
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-text));
  }

  .ta-chatmsg--user {
    align-self: flex-end;
    background: rgb(var(--ta-accent) / 0.12);
    border-color: rgb(var(--ta-accent) / 0.3);
  }

  .ta-chatmsg--assistant {
    align-self: flex-start;
  }

  .ta-chatmsg--system {
    align-self: center;
    background: transparent;
    border-style: dashed;
    color: rgb(var(--ta-text-dim));
  }

  .ta-chatmsg-author {
    font-size: 0.75rem;
    font-weight: 600;
    color: rgb(var(--ta-text-dim));
  }

  .ta-chatmsg-body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }

  .ta-chatmsg-footer {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-chatmsg-typing {
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.25rem 0;
  }

  .ta-chatmsg-typing span {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: rgb(var(--ta-text-dim));
    animation: ta-chatmsg-dot 1.2s infinite ease-in-out;
  }

  .ta-chatmsg-typing span:nth-child(2) { animation-delay: 0.15s; }
  .ta-chatmsg-typing span:nth-child(3) { animation-delay: 0.3s; }

  @keyframes ta-chatmsg-dot {
    0%, 80%, 100% { opacity: 0.3; }
    40% { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-chatmsg-typing span { animation: none; }
  }
</style>
