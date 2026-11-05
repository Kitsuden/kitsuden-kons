<!--
  Reports that do not match: both versions with their evidence, and the TO's ruling, applied to
  the real row of the match.
-->
<script lang="ts">
  import { Badge, Button } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import type { Dispute, EvidenceItem } from "../types";
  import Empty from "../ui/Empty.svelte";
  import Messages from "../ui/Messages.svelte";
  import Row from "../ui/Row.svelte";
  import Section from "../ui/Section.svelte";

  const { off = false }: { off?: boolean } = $props();
  const booth = useBooth();

  const evidenceOf = (d: Dispute, reportedBy: string): EvidenceItem[] =>
    (d.evidence ?? []).find((e) => e.reportedBy === reportedBy)?.items ?? [];
</script>

<Section title="Mismatched reports" {off}>
  {#snippet meta()}
    {#if booth.disputes.length}<Badge variant="warning">{booth.disputes.length} unresolved</Badge>{/if}
  {/snippet}
  {#each booth.disputes as d (d.matchId)}
    <article class="dispute">
      <h4>{d.bracketMatchId || d.matchId}</h4>
      {#if d.reconciliation?.conflict}
        <p class="version">{d.reconciliation.conflict}</p>
      {/if}
      <div class="versions">
        {#each d.reports ?? [] as r (r.reportedBy)}
          {@const items = evidenceOf(d, r.reportedBy)}
          <div class="version">
            {booth.name(r.reportedBy)} says the winner is <b>{booth.name(r.winnerId)}</b>{r.scores
              ? ` (${r.scores[0]}–${r.scores[1]})`
              : ""}
            {#if items.length}
              <div class="proof">
                {#each items as it, i (i)}
                  {#if it.url}
                    <!-- A link pasted by a player is third-party content: `noreferrer` keeps the
                         panel's address from the destination server. -->
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      class:untrusted={!it.trusted}
                      title={it.trusted
                        ? "Uploaded to the site itself"
                        : "Link pasted by the player: it may change or expire"}
                    >
                      {it.caption || (it.trusted ? "Evidence" : "External link")}
                    </a>
                  {:else}
                    <span>{it.caption || "Uploaded image"}</span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <Row>
        {#each booth.sidesOf(d) as pid (pid)}
          <Button size="sm" variant="secondary" onclick={() => booth.resolveDispute(d, pid)}>
            Winner: {booth.name(pid)}
          </Button>
        {/each}
      </Row>
    </article>
  {:else}
    <Empty text="No mismatched reports" />
  {/each}
  <Messages scope="disputes" />
</Section>

<style>
  .dispute {
    padding: 0.7rem 0.8rem;
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-surface));
    border-left: 3px solid rgb(var(--ta-warning));
  }

  h4 {
    margin: 0 0 0.375rem;
    font-size: 0.8125rem;
    font-family: var(--ta-font-mono);
    color: rgb(var(--ta-text));
  }

  .versions {
    display: grid;
    gap: 0.25rem;
    margin: 0.5rem 0;
  }

  .version {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .version b {
    color: rgb(var(--ta-text));
  }

  .proof {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 0.25rem;
  }

  .proof a,
  .proof span {
    font-size: 0.6875rem;
    padding: 0.125rem 0.45rem;
    border-radius: var(--ta-radius-sm);
    text-decoration: none;
    background: rgb(var(--ta-bg));
    color: rgb(var(--ta-text-dim));
    border: 1px solid rgb(var(--ta-border));
  }

  .proof a:hover,
  .proof a:focus-visible {
    color: rgb(var(--ta-text));
  }

  .proof a.untrusted {
    border-style: dashed;
  }
</style>
