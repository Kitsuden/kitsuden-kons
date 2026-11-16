<!-- Which channel a conversation came by: a small glyph with its name for screen readers. -->
<script lang="ts">
  import type { ChannelKind } from "../types";

  const { kind, size = 16 }: { kind: ChannelKind | null | undefined; size?: number } = $props();

  const NAMES: Record<ChannelKind, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", webchat: "Web chat" };
  const PATHS: Record<ChannelKind, string> = {
    // A phone in a speech bubble.
    whatsapp: "M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5zM9.2 8.2c.3 0 .5 0 .7.5l.8 1.8c.1.3 0 .5-.2.7l-.6.7c.6 1.2 1.6 2.2 2.8 2.8l.7-.6c.2-.2.4-.3.7-.2l1.8.8c.4.2.5.4.5.7 0 .9-.8 1.9-1.9 1.9-3.4 0-6.9-3.5-6.9-6.9 0-1.1 1-1.9 1.9-1.9z",
    // A lightning bolt in a speech bubble.
    messenger: "M12 3.5c-4.7 0-8.5 3.5-8.5 8 0 2.4 1.1 4.6 2.9 6v3l2.8-1.5c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.5 8.5-8s-3.8-8-8.5-8zM7 14l3.5-3.8 2 2L16.5 9 13 12.8l-2-2L7 14z",
    // A camera.
    instagram: "M7.5 3.5h9a4 4 0 0 1 4 4v9a4 4 0 0 1-4 4h-9a4 4 0 0 1-4-4v-9a4 4 0 0 1 4-4zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM17.2 6.3v.1",
    // A globe.
    webchat: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17",
  };
  const FILLED: Record<ChannelKind, boolean> = { whatsapp: false, messenger: false, instagram: false, webchat: false };
</script>

{#if kind}
  <svg
    class="channel channel--{kind}"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    role="img"
    aria-label={NAMES[kind]}
    fill={FILLED[kind] ? "currentColor" : "none"}
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <title>{NAMES[kind]}</title>
    <path d={PATHS[kind]} />
  </svg>
{/if}

<style>
  .channel {
    flex-shrink: 0;
  }
  .channel--whatsapp {
    color: rgb(var(--ta-success));
  }
  .channel--messenger {
    color: rgb(var(--ta-info));
  }
  .channel--instagram {
    color: rgb(var(--ta-accent-2));
  }
  .channel--webchat {
    color: rgb(var(--ta-accent-hover));
  }
</style>
