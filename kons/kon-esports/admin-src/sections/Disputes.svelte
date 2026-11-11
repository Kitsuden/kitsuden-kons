<!--
  Reports that do not match: both versions with their evidence, and the TO's ruling, applied to
  the real row of the match.
-->
<script lang="ts">
  import { Badge, Button, DescriptionList, type DescriptionItem } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import type { Dispute, EvidenceItem } from "../types";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";

  const booth = useBooth();

  const evidenceOf = (d: Dispute, reportedBy: string): EvidenceItem[] =>
    (d.evidence ?? []).find((e) => e.reportedBy === reportedBy)?.items ?? [];

  /** One pair per report: who says it, and what they say with their evidence. */
  const claims = (d: Dispute): DescriptionItem[] =>
    (d.reports ?? []).map((r) => ({
      label: `${booth.name(r.reportedBy)} reports`,
      value: `${booth.name(r.winnerId)} won${r.scores ? ` ${r.scores[0]}–${r.scores[1]}` : ""}`,
      evidence: evidenceOf(d, r.reportedBy),
    }));

  const slot = (d: Dispute) => d.bracketMatchId || d.matchId;
</script>

<Panel title="Mismatched reports">
  {#snippet status()}
    {#if booth.loads.disputes.ready}
      <Badge variant={booth.disputes.length ? "warning" : "default"}>{booth.disputes.length} unresolved</Badge>
    {/if}
  {/snippet}
  <Loadable
    load={booth.loads.disputes}
    errorTitle="The reports did not load"
    lines={4}
    empty={booth.disputes.length === 0}
    emptyTitle="No mismatched reports"
    emptyDescription="When the two players of a set report different results, the set appears here for a ruling."
  >
    {#each booth.disputes as d (d.matchId)}
      <article class="dispute" aria-labelledby={`dispute-${d.matchId}`}>
        <h3 class="sub" id={`dispute-${d.matchId}`}>
          <span class="id">{slot(d)}</span>
          {#if d.reconciliation?.conflict}<span class="conflict">{d.reconciliation.conflict}</span>{/if}
        </h3>
        <DescriptionList ariaLabel={`Reports of ${slot(d)}`} items={claims(d)}>
          {#snippet value(item)}
            {@const items = item.evidence as EvidenceItem[]}
            <span>{item.value}</span>
            {#if items.length}
              <ul class="proof" aria-label="Evidence">
                {#each items as it, i (i)}
                  <li>
                    {#if it.url}
                      <!-- A link pasted by a player is third-party content: `noreferrer` keeps the
                           panel's address from the destination server. -->
                      <Button href={it.url} size="sm" variant="outline" target="_blank" rel="noreferrer noopener">
                        {it.caption || (it.trusted ? "Evidence" : "External link")}
                      </Button>
                      {#if it.trusted}
                        <Badge variant="success" dot>Uploaded to the site</Badge>
                      {:else}
                        <Badge variant="warning" dot>Pasted by the player: it may change or expire</Badge>
                      {/if}
                    {:else}
                      <Badge>{it.caption || "Uploaded image"}</Badge>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          {/snippet}
        </DescriptionList>
        <div class="ruling">
          {#each booth.sidesOf(d) as pid (pid)}
            <Button
              variant="secondary"
              ariaLabel={`Give ${slot(d)} to ${booth.name(pid)}`}
              onclick={() => booth.resolveDispute(d, pid)}
            >
              Give the set to {booth.name(pid)}
            </Button>
          {/each}
        </div>
      </article>
    {/each}
  </Loadable>
</Panel>

<style>
  .dispute {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .dispute + .dispute {
    padding-top: 1rem;
    border-top: 1px solid rgb(var(--ta-border));
  }

  .sub {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .id {
    font-family: var(--ta-font-mono);
  }

  .conflict {
    font-weight: 400;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .proof {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0.375rem 0 0;
    padding: 0;
    list-style: none;
  }

  .proof li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem 0.5rem;
  }

  .ruling {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
