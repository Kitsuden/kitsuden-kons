<!--
  What changed between the open list and another one: who moved up, who moved down, who is new
  and who is gone, each with its row before and after, and the same as markdown for the post.

  The comparison is against ANOTHER template: each published version is its own entry
  (`meta-14-1`, `meta-14-2`), so the previous one is in the same list of templates.
-->
<script lang="ts">
  import { Button, DiffView, EmptyState, Field, Select } from "$lib/components";

  import { seg, type Api } from "./api";
  import { diffChanges, diffGroups, diffMarkdown, titled } from "./format";
  import type { Diff, TemplateSummary } from "./types";
  import { failed } from "./ui/notify";
  import Panel from "./ui/Panel.svelte";

  const { api, slug, templates }: { api: Api; slug: string | null; templates: TemplateSummary[] } = $props();

  const others = $derived(templates.filter((t) => t.slug !== slug));
  const diffOptions = $derived(others.map((t) => ({ value: t.id, label: titled(t) })));
  let diffValue = $derived(others[0]?.id ?? "");
  let lastDiff = $state<Diff | null>(null);
  let comparing = $state(false);
  let copied = $state(false);

  async function diff() {
    const otherId = diffValue;
    if (!otherId || !slug) return;
    comparing = true;
    try {
      const payload = await api.tierlist<{ data: Diff }>(`templates/${seg(slug)}/diff/${seg(otherId)}`);
      lastDiff = payload.data;
    } catch (e) {
      failed("Could not compare", e);
    } finally {
      comparing = false;
    }
  }

  async function copyDiff() {
    if (!lastDiff) return;
    try {
      await navigator.clipboard.writeText(diffMarkdown(lastDiff));
      copied = true;
    } catch (e) {
      // The clipboard fails without a user gesture or without permission.
      failed("The browser blocked the clipboard", e);
      return;
    }
    setTimeout(() => (copied = false), 1500);
  }
</script>

<Panel title="What changed" description="The changes against another version, ready for the update post.">
  {#snippet actions()}
    <Button variant="secondary" disabled={!lastDiff} onclick={copyDiff}>
      {copied ? "Copied" : "Copy as markdown"}
    </Button>
  {/snippet}

  <div class="pick">
    <Field label="Compare with">
      <Select
        aria-label="Version to compare with"
        bind:value={diffValue}
        options={diffOptions}
        placeholder={diffOptions.length ? undefined : "No other version"}
        disabled={!diffOptions.length}
      />
    </Field>
    <Button variant="secondary" disabled={others.length === 0} loading={comparing} onclick={diff}>Compare</Button>
  </div>

  {#if lastDiff}
    {@const groups = diffGroups(lastDiff)}
    {#each groups as [title, changes] (title)}
      <section class="group">
        <h3 class="sub">{title} ({changes.length})</h3>
        <DiffView compact ariaLabel={title} changes={diffChanges(title, changes)} />
      </section>
    {:else}
      <EmptyState size="sm" level={null} icon={false} title="No changes between these two versions" />
    {/each}
    {#if groups.length}
      <!-- Those that did not move are COUNTED, not listed. -->
      <p class="unchanged">{lastDiff.unchanged} unchanged</p>
    {/if}
  {/if}
</Panel>

<style>
  .pick {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .pick > :global(.ta-field) {
    flex: 1 1 14rem;
    min-width: 0;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  .sub {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .unchanged {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
