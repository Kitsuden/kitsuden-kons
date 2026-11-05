<svelte:options
  customElement={{
    tag: "broadcast-classifications",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <broadcast-classifications>: which classifications the broadcast offers.

  The CATALOG (which exist, which games each brings) comes from the kon:
  `GET /broadcast/classifications`. The SELECTION lives in the module settings:
  `PATCH /modules/kon-broadcast` with `{ settings: { classifications } }`. With nothing stored,
  the catalog's default is what is active.
-->
<script lang="ts">
  import { Alert, Badge, Checkbox, ThemeScope } from "$lib/components";

  import { untrack } from "svelte";

  import { apiBaseOf, createApi, messageOf } from "./api";
  import type { Classification, ViewContext } from "./types";

  let { context }: { context?: ViewContext; params?: unknown } = $props();

  const api = createApi(() => apiBaseOf(context));

  interface ModulesResponse {
    categories?: Record<string, { modules?: { key: string; settings?: { classifications?: unknown } }[] }>;
  }

  let catalog = $state<Classification[]>([]);
  let fallback = $state<string[]>([]);
  /** What is stored; `null` when nothing is, which means the catalog's default. */
  let stored = $state<string[] | null>(null);
  /** One checkbox per classification. */
  let checks = $state<Record<string, boolean>>({});
  let loaded = $state(false);
  let notice = $state<{ kind: "info" | "success" | "error"; text: string } | null>(null);

  let loadedBase: string | null = null;
  $effect(() => {
    const base = apiBaseOf(context);
    if (base === loadedBase) return;
    loadedBase = base;
    untrack(() => void load());
  });

  /** `settings.classifications` of the broadcast module; `/modules` groups them by category. */
  function readSetting(response: ModulesResponse | null): string[] | null {
    for (const category of Object.values(response?.categories ?? {})) {
      for (const mod of category?.modules ?? []) {
        if (mod.key !== "kon-broadcast") continue;
        const saved = mod.settings?.classifications;
        return Array.isArray(saved) && saved.length > 0 ? (saved as string[]) : null;
      }
    }
    return null;
  }

  function paint() {
    const active = stored ?? fallback;
    checks = Object.fromEntries(catalog.map((c) => [c.id, active.includes(c.id)]));
  }

  async function load() {
    try {
      const [cat, modules] = await Promise.all([
        api.get<{ data?: Classification[]; default?: string[] }>("/broadcast/classifications"),
        // The selection is optional: without it, the default applies.
        api.get<ModulesResponse>("/modules").catch(() => null),
      ]);
      catalog = cat.data ?? [];
      fallback = cat.default ?? [];
      stored = readSetting(modules);
      paint();
    } catch (e) {
      notice = { kind: "error", text: `The classifications could not be loaded: ${messageOf(e)}` };
    } finally {
      loaded = true;
    }
  }

  function changed(id: string, value: boolean) {
    checks[id] = value;
    const selected = catalog.filter((c) => checks[c.id]).map((c) => c.id);
    // Zero classifications leave the scoreboard with no games at all, which looks broken: refused
    // here instead of saved.
    if (selected.length === 0) {
      checks[id] = true;
      notice = { kind: "error", text: "At least one classification must stay active." };
      return;
    }
    void save(selected);
  }

  async function save(selected: string[]) {
    notice = { kind: "info", text: "Saving…" };
    try {
      await api.patch("/modules/kon-broadcast", { settings: { classifications: selected } });
      stored = selected;
      paint();
      notice = { kind: "success", text: "Saved." };
    } catch (e) {
      notice = { kind: "error", text: `Could not save: ${messageOf(e)}` };
      // Reload so the checkboxes do not lie about what is stored.
      void load();
    }
  }
</script>

<ThemeScope class="broadcast-classifications">
  <header class="header">
    <h2>Classifications</h2>
    <p class="sub">
      Which forms of matchup the scoreboard offers. Each one changes how the result is counted, not
      just which games appear.
    </p>
  </header>

  <div class="list">
    {#each catalog as c (c.id)}
      <div class="row" class:on={checks[c.id]}>
        <Checkbox bind:checked={checks[c.id]} onchange={(e: Event) => changed(c.id, (e.currentTarget as HTMLInputElement).checked)}>
          <span class="name">{c.name}</span>
        </Checkbox>
        {#if c.description}<p class="desc">{c.description}</p>{/if}
        <div class="games">
          {#each c.games ?? [] as g (g.id)}
            <Badge>{g.name}</Badge>
          {:else}
            <span class="none">No games</span>
          {/each}
        </div>
      </div>
    {:else}
      {#if loaded}<p class="none">No classifications</p>{/if}
    {/each}
  </div>

  {#if notice}
    <Alert variant={notice.kind}>{notice.text}</Alert>
  {/if}
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.broadcast-classifications) {
    display: grid;
    gap: 1rem;
  }

  h2 {
    margin: 0 0 0.35rem;
    font-size: 1.05rem;
    font-weight: 700;
    color: rgb(var(--ta-text));
  }

  .sub {
    margin: 0;
    font-size: 0.8rem;
    color: rgb(var(--ta-text-dim));
  }

  .list {
    display: grid;
    gap: 0.75rem;
  }

  .row {
    display: grid;
    gap: 0.4rem;
    padding: 0.9rem 1rem;
    border-radius: var(--ta-radius-lg);
    border: 1px solid rgb(var(--ta-border));
    background: rgb(var(--ta-surface));
  }

  .row.on {
    border-color: rgb(var(--ta-accent));
  }

  .name {
    font-weight: 600;
  }

  .desc {
    margin: 0 0 0 1.5rem;
    font-size: 0.78rem;
    color: rgb(var(--ta-text-dim));
  }

  .games {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-left: 1.5rem;
  }

  .none {
    margin: 0;
    font-size: 0.78rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
