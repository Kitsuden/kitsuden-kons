<!--
  Who is still alive, from the bracket response. It is NOT a ranking (there is no placement):
  sorted by status and losses.
-->
<script lang="ts">
  import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Section from "../ui/Section.svelte";

  const { off = false }: { off?: boolean } = $props();
  const booth = useBooth();

  const ORDER: Record<string, number> = { champion: 0, active: 1, eliminated: 2 };
  const TAG: Record<string, string> = { champion: "Champion", active: "Still alive", eliminated: "Eliminated" };

  const rows = $derived(
    [...booth.alive].sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || a.losses - b.losses)
  );
</script>

<Section title="Participants" {off}>
  {#snippet meta()}Who is still alive{/snippet}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Participant</TableHead>
        <TableHead>Losses</TableHead>
        <TableHead>Status</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each rows as s (s.participantId)}
        <TableRow>
          <TableCell>{s.name || booth.name(s.participantId)}</TableCell>
          <TableCell>{s.losses}</TableCell>
          <TableCell>{TAG[s.status] ?? s.status}</TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={3} text="No participants" />
      {/each}
    </TableBody>
  </Table>
</Section>
