<!-- Client portal links: which work, which expired, and revoking one that works. -->
<script lang="ts">
  import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components";
  import { untrack } from "svelte";

  import { fail, seg, type Api, type Note } from "../api";
  import type { PortalLink } from "../types";
  import EmptyRow from "../ui/EmptyRow.svelte";
  import Panel from "../ui/Panel.svelte";
  import Result from "../ui/Result.svelte";

  const { api }: { api: Api } = $props();

  let links = $state<PortalLink[]>([]);
  let note = $state<Note | null>(null);

  async function load() {
    try {
      links = (await api.get<{ data: PortalLink[] }>("portal-links")).data;
    } catch (e) {
      note = fail(e);
    }
  }

  $effect(() => {
    untrack(load);
  });

  async function revoke(link: PortalLink) {
    try {
      await api.del(`portal-links/${seg(link.id)}`);
      await load();
    } catch (e) {
      note = fail(e);
    }
  }
</script>

<Panel title="Client portal links">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Contact</TableHead>
        <TableHead>Until</TableHead>
        <TableHead>State</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each links as l (l.id)}
        <TableRow>
          <TableCell>{l.contactId}</TableCell>
          <TableCell>{String(l.expiresAt).slice(0, 10)}</TableCell>
          <TableCell>{l.live ? "Working" : l.revokedAt ? "Revoked" : "Expired"}</TableCell>
          <TableCell>
            {#if l.live}<Button size="sm" variant="ghost" onclick={() => revoke(l)}>Revoke</Button>{/if}
          </TableCell>
        </TableRow>
      {:else}
        <EmptyRow columns={4} text="No links" />
      {/each}
    </TableBody>
  </Table>
  <Result {note} />
</Panel>
