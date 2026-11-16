<!--
  Economy of one server: each currency members hold (coins, XP, any a blueprint invents), the
  ranking of the one picked, and a member's file (balances, items, activity). The team can give,
  take or set a balance by hand, with a reason the kon event carries.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import {
    Badge,
    Button,
    DashboardGrid,
    DataTable,
    DescriptionList,
    Dialog,
    Field,
    Input,
    KpiCard,
    LineChart,
    NumberInput,
    Select,
    Skeleton,
    ToggleGroup,
    type DataColumn,
  } from "$lib/components";

  import { useApi } from "../../context";
  import type { Economy, MemberFile, Ranked } from "../../types";
  import FormGrid from "../../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../../ui/labels";
  import Panel from "../../ui/Panel.svelte";
  import RowMenu from "../../ui/RowMenu.svelte";
  import { createLoad, message } from "../../ui/load.svelte";
  import { failed, toast } from "../../ui/notify";

  const { guildId }: { guildId: string } = $props();
  const api = useApi();
  const SNOWFLAKE = /^\d{15,20}$/;
  const fmt = new Intl.NumberFormat();

  let economy = $state<Economy | null>(null);
  let currency = $state("");
  const load = createLoad(async () => {
    const q = currency ? `?currency=${encodeURIComponent(currency)}&limit=200` : "?limit=200";
    economy = await api.get<Economy>(`/guilds/${guildId}/economy${q}`);
    currency = economy.currency;
  });
  $effect(() => {
    void guildId;
    untrack(() => {
      currency = "";
      void load.load();
    });
  });

  const currencyOptions = $derived(
    (economy?.currencies.length ? economy.currencies : [{ currency: economy?.currency ?? "coins", members: 0, total: 0 }]).map((c) => ({
      value: c.currency,
      label: `${c.currency} (${c.members})`,
    }))
  );
  const held = $derived(economy?.currencies.find((c) => c.currency === economy?.currency));
  const rows = $derived((economy?.docs ?? []).map((r, i) => ({ ...r, rank: i + 1 })));
  const top = $derived(rows[0]?.value ?? 0);

  const columns: DataColumn<Ranked & { rank: number }>[] = [
    { key: "rank", header: "#", width: "3.5rem", align: "right" },
    { key: "member", header: "Member", value: (r) => r.name ?? r.userId },
    { key: "value", header: "Balance", align: "right", sortable: true, value: (r) => fmt.format(r.value) },
  ];

  // ── Give, take or set ──────────────────────────────────────────────────────
  type Mode = "give" | "take" | "set";
  let adjustOpen = $state(false);
  let adjust = $state<{ userId: string; currency: string; mode: Mode; amount: number | null; reason: string }>({
    userId: "",
    currency: "coins",
    mode: "give",
    amount: 100,
    reason: "",
  });
  let adjusting = $state(false);
  const adjustOk = $derived(SNOWFLAKE.test(adjust.userId) && /^[a-z0-9_-]{1,32}$/.test(adjust.currency) && adjust.amount !== null && adjust.amount >= 0);

  function openAdjust(userId = "", mode: Mode = "give") {
    adjust = { userId, currency: economy?.currency || "coins", mode, amount: mode === "set" ? 0 : 100, reason: "" };
    adjustOpen = true;
  }

  async function saveAdjust() {
    if (!adjustOk || adjust.amount === null) return;
    adjusting = true;
    try {
      const body =
        adjust.mode === "set"
          ? { currency: adjust.currency, set: adjust.amount }
          : { currency: adjust.currency, add: adjust.mode === "give" ? adjust.amount : -adjust.amount };
      const r = await api.put<{ balance: number }>(`/guilds/${guildId}/economy/${adjust.userId}`, {
        ...body,
        ...(adjust.reason.trim() ? { reason: adjust.reason.trim() } : {}),
      });
      toast.success(`New balance: ${fmt.format(r.balance)} ${adjust.currency}`);
      adjustOpen = false;
      currency = adjust.currency;
      await load.load();
      if (fileOpen && file?.userId === adjust.userId) await openFile(adjust.userId);
    } catch (e) {
      failed("The balance did not change", e);
    } finally {
      adjusting = false;
    }
  }

  // ── A member's file ────────────────────────────────────────────────────────
  let fileOpen = $state(false);
  let file = $state<MemberFile | null>(null);
  let fileError = $state<string | null>(null);
  let lookup = $state("");

  async function openFile(userId: string) {
    fileOpen = true;
    fileError = null;
    if (file?.userId !== userId) file = null;
    try {
      file = await api.get<MemberFile>(`/guilds/${guildId}/members/${userId}`);
    } catch (e) {
      fileError = message(e);
    }
  }
  const fileDays = $derived((file?.activity.days ?? []).map((d) => ({ ...d, day: d.date.slice(5) })));
</script>

<Panel title="Economy" description="Balances members hold in this server: coins, XP and any currency a blueprint uses.">
  {#snippet status()}
    {#if economy}<Badge>{economy.currencies.length} currenc{economy.currencies.length === 1 ? "y" : "ies"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button size="sm" onclick={() => openAdjust()}>Give or take</Button>
  {/snippet}

  <div class="toolbar">
    <Field label="Currency">
      <Select bind:value={currency} options={currencyOptions} onchange={() => void load.load()} />
    </Field>
    <FormGrid label="Look up a member" onsubmit={() => SNOWFLAKE.test(lookup) && openFile(lookup)}>
      <Field label="Member id">
        <Input bind:value={lookup} inputmode="numeric" placeholder="123456789012345678" />
      </Field>
      {#snippet actions()}
        <Button variant="secondary" type="submit" disabled={!SNOWFLAKE.test(lookup)}>Open</Button>
      {/snippet}
    </FormGrid>
  </div>

  {#if economy}
    <DashboardGrid columns={3}>
      <KpiCard label={`Members holding ${economy.currency}`} value={held?.members ?? 0} />
      <KpiCard label="In circulation" value={economy.total} />
      <KpiCard label="Top balance" value={top} />
    </DashboardGrid>
  {/if}

  <DataTable
    caption={`Ranking by ${economy?.currency ?? "balance"}`}
    {rows}
    {columns}
    rowKey="userId"
    rowLabel={(r) => r.name ?? r.userId}
    loading={load.loading}
    error={load.error}
    onRetry={load.load}
    emptyText="Nobody holds this currency yet."
  >
    {#snippet cell(r, col)}
      {#if col.key === "member"}
        <button class="member" type="button" onclick={() => openFile(r.userId)}>
          <span>{r.name ?? "Unknown name"}</span>
          <code>{r.userId}</code>
        </button>
      {:else if col.key === "rank"}
        {r.rank}
      {:else}
        {col.value?.(r)}
      {/if}
    {/snippet}
    {#snippet rowActions(r)}
      <RowMenu
        label={`Actions: ${r.name ?? r.userId}`}
        items={[
          { label: "Member file", onSelect: () => openFile(r.userId) },
          { label: "Give", onSelect: () => openAdjust(r.userId, "give") },
          { label: "Take", onSelect: () => openAdjust(r.userId, "take") },
          { label: "Set balance", onSelect: () => openAdjust(r.userId, "set") },
        ]}
      />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open={adjustOpen} title="Give, take or set a balance" closeLabel={CLOSE}>
  <FormGrid label="Change a balance" onsubmit={saveAdjust}>
    <Field label="Member id">
      <Input bind:value={adjust.userId} inputmode="numeric" placeholder="123456789012345678" />
    </Field>
    <Field label="Currency">
      <Input bind:value={adjust.currency} maxlength={32} placeholder="coins" />
    </Field>
    <ToggleGroup
      label="What to do"
      variant="segmented"
      bind:value={adjust.mode}
      options={[
        { value: "give", label: "Give" },
        { value: "take", label: "Take" },
        { value: "set", label: "Set to" },
      ]}
    />
    <Field label={adjust.mode === "set" ? "New balance" : "Amount"}>
      <NumberInput bind:value={adjust.amount} min={0} step={10} stepper />
    </Field>
    <Field label="Reason (optional, goes with the kon event)">
      <Input bind:value={adjust.reason} maxlength={200} placeholder="Event prize" />
    </Field>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (adjustOpen = false)}>{CANCEL}</Button>
    <Button loading={adjusting} disabled={!adjustOk} onclick={saveAdjust}>
      {adjust.mode === "give" ? "Give" : adjust.mode === "take" ? "Take" : "Set"}
    </Button>
  {/snippet}
</Dialog>

<Dialog bind:open={fileOpen} title={file?.profile?.name ? `${file.profile.name}` : "Member"} closeLabel={CLOSE} size="lg">
  <div class="file">
    {#if fileError}
      <p class="quiet">{fileError}</p>
    {:else if !file}
      <Skeleton lines={5} />
    {:else}
      <DescriptionList
        ariaLabel="Member"
        columns={2}
        items={[
          { label: "Discord id", value: file.userId, mono: true, copy: true },
          { label: "Reputation", value: file.profile?.rep ?? 0 },
          { label: "Daily streak", value: file.profile?.dailyStreak ?? 0 },
          { label: "Badges", value: file.profile?.badges.join(", ") || null },
          { label: "Bio", value: file.profile?.bio ?? null },
        ]}
      />
      <section>
        <h3>Balances</h3>
        {#if file.balances.length}
          <ul class="chips">
            {#each file.balances as b (b.currency)}
              <li><Badge>{b.currency}</Badge> {fmt.format(b.balance)}</li>
            {/each}
          </ul>
        {:else}
          <p class="quiet">No balance in this server.</p>
        {/if}
      </section>
      <section>
        <h3>Items</h3>
        {#if file.items.length}
          <ul class="chips">
            {#each file.items as it (it.item)}
              <li>{it.emoji ?? ""} {it.name ?? it.item} <span class="quiet">×{it.quantity}</span></li>
            {/each}
          </ul>
        {:else}
          <p class="quiet">No items.</p>
        {/if}
      </section>
      <LineChart
        data={fileDays}
        x="day"
        xLabel="Day"
        series={[
          { key: "messages", label: "Messages" },
          { key: "voiceMinutes", label: "Voice minutes" },
        ]}
        title={`Last 30 days: ${fmt.format(file.activity.messages)} messages, ${fmt.format(file.activity.voiceMinutes)} voice minutes`}
        height={180}
      />
    {/if}
  </div>
  {#snippet footer()}
    {#if file}
      <Button variant="ghost" onclick={() => file && openAdjust(file.userId, "take")}>Take</Button>
      <Button onclick={() => file && openAdjust(file.userId, "give")}>Give</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .toolbar {
    display: grid;
    grid-template-columns: minmax(10rem, 16rem) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }

  @media (max-width: 47.99rem) {
    .toolbar {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .member {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    min-height: 2.75rem;
    justify-content: center;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .member:hover span,
  .member:focus-visible span {
    text-decoration: underline;
  }

  .member code {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .file {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  h3 {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .quiet {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
