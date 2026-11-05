<!--
  Swiss: its own standings (with OMW, the tiebreaker that decides a top 8), pairing the next
  round and the cut.
-->
<script lang="ts">
  import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Messages from "../ui/Messages.svelte";
  import Row from "../ui/Row.svelte";
  import Section from "../ui/Section.svelte";

  const { off = false }: { off?: boolean } = $props();
  const booth = useBooth();

  const pct = (n: number | undefined) => `${Math.round((n ?? 0) * 100)}%`;
  const swiss = $derived(booth.swiss);
</script>

<Section title="Swiss" {off}>
  {#snippet meta()}
    {#if swiss}
      {swiss.complete ? `finished · ${swiss.totalRounds} rounds` : `round ${swiss.round} of ${swiss.totalRounds}`}
    {/if}
  {/snippet}
  <Row>
    <Button disabled={swiss?.complete ?? false} onclick={() => booth.swissNextRound()}>Pair next round</Button>
    <Button variant="secondary" onclick={() => booth.swissCut()}>See the cut</Button>
  </Row>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>#</TableHead>
        <TableHead>Participant</TableHead>
        <TableHead>V-D-E</TableHead>
        <TableHead>Points</TableHead>
        <TableHead>OMW</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each swiss?.standings ?? [] as s (s.participantId)}
        <TableRow>
          <TableCell>{s.place ?? ""}</TableCell>
          <TableCell>{booth.name(s.participantId)}</TableCell>
          <TableCell>{s.record?.wins ?? 0}-{s.record?.losses ?? 0}-{s.record?.draws ?? 0}</TableCell>
          <TableCell>{s.record?.points ?? 0}</TableCell>
          <TableCell>{pct(s.omw)}</TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={5} text="There are no results yet." />
      {/each}
    </TableBody>
  </Table>
  <Messages scope="swiss" />
</Section>
