<svelte:options
  customElement={{
    tag: "odoo-status",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <odoo-status>: the state of the Odoo connection, and what a person has to look at.

  Oversight, not daily work: whether Odoo is reachable and what it has installed, how fresh the
  mirror is, orders Odoo refused, and what the sync could not settle. The two actions are the ones
  that put things right without leaving the panel: ask Odoo again what it has, and read the whole
  catalog. Everything shown comes from `GET /odoo/status`, which never calls Odoo.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls use the browser's cookies.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { Alert, Badge, Button, DataTable, EmptyState } from "$lib/components";
  import type { DataColumn } from "$lib/components";

  import { createApi } from "./api";
  import Loadable from "./ui/Loadable.svelte";
  import { createLoad } from "./ui/load.svelte";
  import { failed, toast } from "./ui/notify";
  import Panel from "./ui/Panel.svelte";
  import View from "./ui/View.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
  }

  interface Capabilities {
    stock: boolean;
    website: boolean;
    variants: boolean;
    loyalty: boolean;
    payments: boolean;
    bridge: boolean;
    checkedAt: string;
  }

  interface Run {
    id: string;
    status: "running" | "done" | "failed";
    products: number;
    variants: number;
    retired: number;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  }

  interface Status {
    configured: boolean;
    problem: string | null;
    host: string | null;
    capabilities: Capabilities | null;
    currency: string | null;
    mirror: { products: number; published: number; variants: number };
    lastNoticeAt: string | null;
    lastFullSyncAt: string | null;
    lastRun: Run | null;
    openConflicts: number;
    pendingOrders: number;
    failedOrders: number;
    keyExpiresOn: string | null;
    keyDaysLeft: number | null;
  }

  interface Conflict {
    id: string;
    kind: string;
    reference: string;
    details: Record<string, unknown>;
    resolvedAt: string | null;
    createdAt: string;
  }

  let { context, params }: { context?: ViewContext; params?: unknown } = $props();

  const api = createApi(() => context?.apiBase || "/api");

  let info = $state<Status | null>(null);
  let conflicts = $state<Conflict[]>([]);
  let checking = $state(false);
  let starting = $state(false);
  let resolving = $state<string | null>(null);

  const open = $derived(conflicts.filter((conflict) => conflict.resolvedAt === null));

  const MODULES: Array<[keyof Omit<Capabilities, "checkedAt">, string]> = [
    ["stock", "Inventory"],
    ["website", "eCommerce"],
    ["variants", "Variants"],
    ["loyalty", "Store credit"],
    ["payments", "Invoicing"],
    ["bridge", "Bridge module"],
  ];

  const KINDS: Record<string, string> = {
    duplicate_reference: "Reference on two variants",
    variant_recreated: "Variant recreated",
    currency_mismatch: "Another currency",
  };

  const data = createLoad(async () => {
    info = await api.get<Status>("/odoo/status");
    conflicts = (await api.get<{ docs?: Conflict[] }>("/odoo/conflicts?limit=100")).docs ?? [];
  });

  // The host may set `context` before or after connecting, and again when the theme changes:
  // load once per API base.
  let loadedBase: string | null = null;
  $effect(() => {
    const base = context?.apiBase || "/api";
    if (base === loadedBase) return;
    loadedBase = base;
    untrack(data.load);
  });

  function when(value: string | null | undefined): string {
    return value ? new Date(value).toLocaleString(context?.locale) : "Never";
  }

  async function check() {
    if (checking) return;
    checking = true;
    try {
      await api.post("/odoo/connection/check", {});
      toast.success("Odoo answered");
      await data.load();
    } catch (e) {
      failed("Could not reach Odoo", e);
    } finally {
      checking = false;
    }
  }

  async function sync() {
    if (starting) return;
    starting = true;
    try {
      const { started } = await api.post<{ started: boolean }>("/odoo/sync", {});
      toast.success(started ? "Reading the catalog" : "A read is already running");
      await data.load();
    } catch (e) {
      failed("Could not start the read", e);
    } finally {
      starting = false;
    }
  }

  async function resolve(conflict: Conflict) {
    if (resolving) return;
    resolving = conflict.id;
    try {
      await api.post(`/odoo/conflicts/${conflict.id}/resolve`, {});
      toast.success("Marked as looked at");
      await data.load();
    } catch (e) {
      failed("Could not close the conflict", e);
    } finally {
      resolving = null;
    }
  }

  const columns: DataColumn<Conflict>[] = [
    { key: "kind", header: "Problem", sortable: true, hideable: false, value: (c) => KINDS[c.kind] ?? c.kind },
    { key: "reference", header: "Reference", sortable: true },
    { key: "details", header: "Details", value: (c) => JSON.stringify(c.details) },
    { key: "createdAt", header: "Seen", sortable: true },
    { key: "action", header: "", hideable: false, value: () => "" },
  ];
</script>

<View>
  <Panel title="Connection">
    {#snippet status()}
      {#if info}
        <Badge variant={info.configured && info.capabilities ? "success" : "warning"}>
          {info.configured && info.capabilities ? "Connected" : "Not connected"}
        </Badge>
      {/if}
    {/snippet}
    {#snippet actions()}
      <Button variant="secondary" onclick={check} loading={checking} disabled={checking}>Check connection</Button>
      <Button onclick={sync} loading={starting} disabled={starting}>Read whole catalog</Button>
    {/snippet}

    <Loadable load={data}>
      {#if info}
        {#if info.problem}
          <Alert variant="warning" title="Odoo is not configured">{info.problem}</Alert>
        {/if}
        {#if info.keyDaysLeft !== null && info.keyDaysLeft <= 14}
          <Alert variant={info.keyDaysLeft <= 3 ? "error" : "warning"} title="The API key expires soon">
            {info.keyDaysLeft <= 0 ? "It has expired." : `${info.keyDaysLeft} days left (${info.keyExpiresOn}).`}
          </Alert>
        {/if}
        <dl>
          <div>
            <dt>Host</dt>
            <dd>{info.host ?? "—"}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>{info.currency ?? "—"}</dd>
          </div>
          <div>
            <dt>API key expires</dt>
            <dd>{info.keyExpiresOn ?? "—"}</dd>
          </div>
          <div>
            <dt>Installed in Odoo</dt>
            <dd class="badges">
              {#if info.capabilities}
                {#each MODULES as [key, label] (key)}
                  <Badge variant={info.capabilities[key] ? "success" : "secondary"}>{label}</Badge>
                {/each}
              {:else}
                —
              {/if}
            </dd>
          </div>
        </dl>
      {/if}
    </Loadable>
  </Panel>

  <Panel title="Mirror">
    {#snippet status()}
      {#if info?.lastRun}
        <Badge variant={info.lastRun.status === "failed" ? "error" : info.lastRun.status === "running" ? "info" : "secondary"}>
          {info.lastRun.status === "failed" ? "Last read failed" : info.lastRun.status === "running" ? "Reading" : "In step"}
        </Badge>
      {/if}
    {/snippet}

    <Loadable load={data}>
      {#if info}
        {#if info.lastRun?.status === "failed" && info.lastRun.error}
          <Alert variant="error" title="The last read of the catalog stopped">{info.lastRun.error}</Alert>
        {/if}
        <dl>
          <div>
            <dt>Products</dt>
            <dd>{info.mirror.products}</dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd>{info.mirror.published}</dd>
          </div>
          <div>
            <dt>Variants</dt>
            <dd>{info.mirror.variants}</dd>
          </div>
          <div>
            <dt>Last notice from Odoo</dt>
            <dd>{when(info.lastNoticeAt)}</dd>
          </div>
          <div>
            <dt>Last whole read</dt>
            <dd>{when(info.lastFullSyncAt)}</dd>
          </div>
          <div>
            <dt>Orders waiting for Odoo</dt>
            <dd>{info.pendingOrders}</dd>
          </div>
          <div>
            <dt>Orders Odoo refused</dt>
            <dd>
              {#if info.failedOrders > 0}<Badge variant="error">{info.failedOrders}</Badge>{:else}0{/if}
            </dd>
          </div>
        </dl>
      {/if}
    </Loadable>
  </Panel>

  <Panel title="Conflicts">
    {#snippet status()}
      {#if data.ready}<Badge variant={open.length > 0 ? "warning" : "secondary"}>{open.length} open</Badge>{/if}
    {/snippet}
    <DataTable
      caption="Conflicts"
      rows={conflicts}
      {columns}
      rowKey="id"
      rowLabel={(conflict) => conflict.reference}
      pageSize={25}
      loading={data.loading}
      error={data.error}
      onRetry={data.load}
    >
      {#snippet cell(conflict, col)}
        {#if col.key === "reference"}
          <code>{conflict.reference}</code>
        {:else if col.key === "details"}
          <code>{JSON.stringify(conflict.details)}</code>
        {:else if col.key === "createdAt"}
          {when(conflict.createdAt)}
        {:else if col.key === "action"}
          {#if conflict.resolvedAt === null}
            <Button
              size="sm"
              variant="secondary"
              onclick={() => resolve(conflict)}
              loading={resolving === conflict.id}
              disabled={resolving !== null}
            >
              Mark as looked at
            </Button>
          {:else}
            <Badge variant="secondary">Closed</Badge>
          {/if}
        {:else}
          {KINDS[conflict.kind] ?? conflict.kind}
        {/if}
      {/snippet}
      {#snippet empty()}
        <EmptyState size="sm" level={null} title="No conflicts" />
      {/snippet}
    </DataTable>
  </Panel>
</View>

<style>
  :host {
    display: block;
  }

  dl {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: 0.75rem 1.5rem;
    margin: 0;
  }

  dt {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  dd {
    margin: 0.125rem 0 0;
    font-size: 0.9375rem;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  code {
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
</style>
