<!--
  The channels: WhatsApp numbers, Facebook pages, Instagram accounts and web chats. Connect one (a form per
  kind), change who answers it (a kon-chat bot, a flow, or people), check its connection with Meta, and
  copy a web chat's embed code.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    CopyButton,
    DataTable,
    Dialog,
    EmptyState,
    Field,
    Input,
    Select,
    Switch,
    Textarea,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { Channel, ChannelKind, ChannelSettings, Team } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import type { Load } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";

  const {
    api,
    chatApi,
    base,
    channels,
    teams,
    load,
  }: { api: Api; chatApi: Api; base: string; channels: Channel[]; teams: Team[]; load: Load } = $props();

  const KINDS: Record<ChannelKind, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", webchat: "Web chat" };
  const ID_LABEL: Record<ChannelKind, string> = {
    whatsapp: "Phone number id",
    messenger: "Facebook page id",
    instagram: "Instagram account id",
    webchat: "Key",
  };
  const TOKEN_LABEL: Record<ChannelKind, string> = {
    whatsapp: "System user access token",
    messenger: "Page access token",
    instagram: "Page access token",
    webchat: "",
  };

  interface Bot {
    slug: string;
    name: string;
    audience?: string;
  }
  interface Flow {
    id: string;
    name: string;
    channelId?: string | null;
  }

  // What can answer in the `bot` state: kon-chat bots and koe flows, when each exists here.
  let bots = $state<Bot[] | null>(null);
  let flows = $state<Flow[] | null>(null);
  $effect(() => {
    untrack(async () => {
      try {
        bots = (await chatApi.get<{ data?: Bot[] }>("bots")).data ?? [];
      } catch {
        bots = null;
      }
      try {
        flows = (await api.get<{ data?: Flow[] }>("flows")).data ?? [];
      } catch {
        flows = null;
      }
    });
  });

  const blank = () => ({
    kind: "whatsapp" as ChannelKind,
    name: "",
    externalId: "",
    accountId: "",
    display: "",
    accessToken: "",
    appSecret: "",
    botSlug: "",
    flowId: "",
    defaultTeamId: "",
    greeting: "",
    preChatForm: false,
    allowedOrigins: "",
    reopenAs: "",
    autoResolveHours: "",
    optOutKeywords: "",
    optInKeywords: "",
    handoffKeywords: "",
  });

  let form = $state(blank());
  let editing = $state<Channel | null>(null);
  let formOpen = $state(false);
  let saving = $state(false);
  let errors = $state<Record<string, string>>({});
  let embedFor = $state<Channel | null>(null);
  let embedOpen = $state(false);
  let deleting = $state<Channel | null>(null);
  let confirmDelete = $state(false);

  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "";
  const answeredBy = (c: Channel) =>
    c.botSlug ? `Bot ${c.botSlug}` : c.settings?.flowId ? `Flow ${flows?.find((f) => f.id === c.settings.flowId)?.name ?? c.settings.flowId}` : "People";

  const columns: DataColumn<Channel>[] = [
    { key: "name", header: "Channel", sortable: true, hideable: false },
    { key: "kind", header: "Kind", sortable: true, value: (c) => KINDS[c.kind], filter: "select" },
    { key: "display", header: "Account", value: (c) => c.display || c.externalId },
    { key: "status", header: "State", sortable: true, filter: "select" },
    { key: "answers", header: "Answers", value: answeredBy },
    { key: "team", header: "Team", value: (c) => teamName(c.defaultTeamId) || "None" },
  ];

  const list = (s: string) =>
    s
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);

  function openNew() {
    editing = null;
    form = blank();
    errors = {};
    formOpen = true;
  }

  function openEdit(c: Channel) {
    editing = c;
    const s = c.settings ?? {};
    form = {
      kind: c.kind,
      name: c.name,
      externalId: c.kind === "webchat" ? c.externalId : c.externalId,
      accountId: c.accountId ?? "",
      display: c.display ?? "",
      accessToken: "",
      appSecret: "",
      botSlug: c.botSlug ?? "",
      flowId: s.flowId ?? "",
      defaultTeamId: c.defaultTeamId ?? "",
      greeting: s.greeting ?? "",
      preChatForm: !!s.preChatForm,
      allowedOrigins: (s.allowedOrigins ?? []).join("\n"),
      reopenAs: s.reopenAs ?? "",
      autoResolveHours: s.autoResolveHours ? String(s.autoResolveHours) : "",
      optOutKeywords: (s.optOutKeywords ?? []).join(", "),
      optInKeywords: (s.optInKeywords ?? []).join(", "),
      handoffKeywords: (s.handoffKeywords ?? []).join(", "),
    };
    errors = {};
    formOpen = true;
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    const meta = form.kind !== "webchat";
    if (!form.name.trim()) e.name = "Give it a name";
    if (meta && !editing) {
      if (!form.externalId.trim()) e.externalId = "Required";
      if (form.accessToken.trim().length < 10) e.accessToken = "Paste the token";
      if (form.appSecret.trim().length < 10) e.appSecret = "Paste the app secret";
    }
    if (form.accessToken && form.accessToken.trim().length < 10) e.accessToken = "That token is too short";
    if (form.appSecret && form.appSecret.trim().length < 10) e.appSecret = "That secret is too short";
    for (const o of list(form.allowedOrigins)) {
      try {
        const u = new URL(o);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      } catch {
        e.allowedOrigins = `Not a site address: ${o}`;
      }
    }
    const h = form.autoResolveHours.trim();
    if (h && (!/^\d+$/.test(h) || Number(h) < 1 || Number(h) > 2160)) e.autoResolveHours = "Hours, from 1 to 2160";
    errors = e;
    return Object.keys(e).length === 0;
  }

  function settingsOf(): ChannelSettings {
    const s: ChannelSettings = {
      flowId: form.flowId.trim(),
      optOutKeywords: list(form.optOutKeywords),
      optInKeywords: list(form.optInKeywords),
      handoffKeywords: list(form.handoffKeywords),
    };
    if (form.reopenAs === "bot" || form.reopenAs === "queued") s.reopenAs = form.reopenAs;
    if (form.autoResolveHours.trim()) s.autoResolveHours = Number(form.autoResolveHours.trim());
    if (form.kind === "webchat") {
      s.greeting = form.greeting.trim();
      s.preChatForm = form.preChatForm;
      s.allowedOrigins = list(form.allowedOrigins).map((o) => new URL(o).origin);
    }
    return s;
  }

  async function save() {
    if (!validate()) return;
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      display: form.display.trim() || null,
      botSlug: form.botSlug.trim() || null,
      defaultTeamId: form.defaultTeamId || null,
      settings: settingsOf(),
    };
    if (form.kind !== "webchat") {
      if (form.externalId.trim()) body.externalId = form.externalId.trim();
      body.accountId = form.accountId.trim() || null;
      if (form.accessToken.trim()) body.accessToken = form.accessToken.trim();
      if (form.appSecret.trim()) body.appSecret = form.appSecret.trim();
    }
    saving = true;
    try {
      if (editing) {
        await api.patch(`channels/${seg(editing.id)}`, body);
        toast.success(`"${body.name}" saved`);
      } else {
        const created = await api.post<{ data: Channel }>("channels", { ...body, kind: form.kind });
        toast.success(`"${body.name}" connected`);
        if (created.data.kind === "webchat") showEmbed(created.data);
      }
      formOpen = false;
      form.accessToken = "";
      form.appSecret = "";
      await load.load();
    } catch (e) {
      failed(editing ? "Could not save the channel" : "Could not connect the channel", e);
    } finally {
      saving = false;
    }
  }

  async function check(c: Channel) {
    try {
      const res = await api.post<{ data: { ok: boolean; error?: string; info?: Record<string, unknown> } }>(`channels/${seg(c.id)}/check`, {});
      if (res.data.ok) {
        const info = res.data.info ?? {};
        const what = [info.verified_name ?? info.name, info.display_phone_number ?? info.username, info.quality_rating && `quality ${String(info.quality_rating).toLowerCase()}`]
          .filter(Boolean)
          .join(" · ");
        toast.success(`"${c.name}" is connected`, what ? { description: what } : undefined);
      } else {
        toast.error(`"${c.name}" is not connected`, { description: res.data.error });
      }
      await load.load();
    } catch (e) {
      failed("Could not check the channel", e);
    }
  }

  async function setStatus(c: Channel, status: "active" | "disabled") {
    try {
      await api.patch(`channels/${seg(c.id)}`, { status });
      toast.success(`"${c.name}" ${status === "active" ? "enabled" : "disabled"}`);
      await load.load();
    } catch (e) {
      failed("Could not change the channel", e);
    }
  }

  async function remove() {
    const c = deleting!;
    try {
      await api.del(`channels/${seg(c.id)}`);
    } catch (e) {
      failed("Could not disconnect the channel", e);
      throw e;
    }
    toast.success(`"${c.name}" disconnected`);
    await load.load();
  }

  function showEmbed(c: Channel) {
    embedFor = c;
    embedOpen = true;
  }

  const snippet = (c: Channel) =>
    `<script src="${base}/public/webchat/widget.js" data-key="${c.externalId}" crossorigin="anonymous" defer></` + "script>";

  const statusVariant = (s: Channel["status"]) => (s === "active" ? "success" : s === "error" ? "error" : "default");
  const statusLabel = (s: Channel["status"]) => (s === "active" ? "Active" : s === "error" ? "Error" : "Disabled");

  const botOptions = $derived([
    { value: "", label: "No AI bot" },
    ...(bots ?? []).map((b) => ({ value: b.slug, label: `${b.name} (${b.slug})` })),
    ...(form.botSlug && !(bots ?? []).some((b) => b.slug === form.botSlug) ? [{ value: form.botSlug, label: form.botSlug }] : []),
  ]);
  const flowOptions = $derived([
    { value: "", label: "No flow" },
    ...(flows ?? []).filter((f) => !f.channelId || f.channelId === editing?.id).map((f) => ({ value: f.id, label: f.name })),
    ...(form.flowId && !(flows ?? []).some((f) => f.id === form.flowId) ? [{ value: form.flowId, label: form.flowId }] : []),
  ]);
  const teamOptions = $derived([{ value: "", label: "No team (supervisors)" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]);
</script>

<Panel title="Channels" description="Each number, page, account or web chat that writes into koe, and what answers it first.">
  {#snippet status()}
    {#if load.ready}<Badge>{channels.length} {channels.length === 1 ? "channel" : "channels"}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    <Button size="sm" onclick={openNew}>Connect channel</Button>
  {/snippet}
  <DataTable
    caption="Channels"
    rows={channels}
    {columns}
    rowKey="id"
    rowLabel={(c) => c.name}
    loading={load.loading}
    error={load.error}
    onRetry={load.load}
  >
    {#snippet cell(c, col)}
      {#if col.key === "name"}
        <span class="name">{c.name}</span>
      {:else if col.key === "kind"}
        <Badge variant={c.kind === "webchat" ? "info" : c.kind === "whatsapp" ? "success" : "accent"}>{KINDS[c.kind]}</Badge>
      {:else if col.key === "status"}
        <span title={c.statusDetail ?? undefined}>
          <Badge variant={statusVariant(c.status)} dot>{statusLabel(c.status)}</Badge>
        </span>
        {#if c.status === "error" && c.statusDetail}<span class="detail">{c.statusDetail}</span>{/if}
        {#if c.quality}<span class="detail">Quality {c.quality}</span>{/if}
      {:else if col.key === "display"}
        <span class="mono">{c.display || c.externalId}</span>
      {:else}
        {col.value?.(c)}
      {/if}
    {/snippet}
    {#snippet rowActions(c)}
      <RowMenu
        label={`Actions: ${c.name}`}
        items={[
          { label: "Edit", onSelect: () => openEdit(c) },
          ...(c.kind === "webchat" ? [{ label: "Embed code", onSelect: () => showEmbed(c) }] : [{ label: "Check connection", onSelect: () => check(c) }]),
          c.status === "disabled" ? { label: "Enable", onSelect: () => setStatus(c, "active") } : { label: "Disable", onSelect: () => setStatus(c, "disabled") },
          {
            label: "Disconnect",
            danger: true,
            separated: true,
            onSelect: () => {
              deleting = c;
              confirmDelete = true;
            },
          },
        ]}
      />
    {/snippet}
    {#snippet empty()}
      <EmptyState size="sm" level={null} title="No channels yet" description="Connect a WhatsApp number, a page, an Instagram account or a web chat." actionLabel="Connect channel" onAction={openNew} />
    {/snippet}
  </DataTable>
</Panel>

<Dialog bind:open={formOpen} title={editing ? `Edit "${editing.name}"` : "Connect a channel"} size="xl" closeLabel={CLOSE}>
  <FormGrid label={editing ? "Edit channel" : "Connect a channel"} onsubmit={save}>
    {#if !editing}
      <Field label="Kind" required>
        <Select
          bind:value={form.kind}
          options={(Object.keys(KINDS) as ChannelKind[]).map((k) => ({ value: k, label: KINDS[k] }))}
        />
      </Field>
    {/if}
    <Field label="Name" required error={errors.name}>
      <Input bind:value={form.name} autocomplete="off" placeholder={form.kind === "webchat" ? "Website chat" : "Support line"} />
    </Field>
    <Field label={form.kind === "webchat" ? "Title shown in the chat" : "Display name"}>
      <Input bind:value={form.display} autocomplete="off" />
    </Field>

    {#if form.kind !== "webchat"}
      <Field label={ID_LABEL[form.kind]} required={!editing} error={errors.externalId}>
        <Input bind:value={form.externalId} autocomplete="off" spellcheck="false" inputmode="numeric" />
      </Field>
      {#if form.kind === "whatsapp"}
        <Field label="WhatsApp Business Account id">
          <Input bind:value={form.accountId} autocomplete="off" spellcheck="false" inputmode="numeric" />
        </Field>
      {/if}
      <Field label={TOKEN_LABEL[form.kind]} required={!editing} error={errors.accessToken} class="wide">
        <Input
          type="password"
          bind:value={form.accessToken}
          autocomplete="off"
          spellcheck="false"
          placeholder={editing?.hasAccessToken ? "Stored. Paste a new one to replace it" : ""}
        />
      </Field>
      <Field label="Meta app secret" required={!editing} error={errors.appSecret} class="wide">
        <Input
          type="password"
          bind:value={form.appSecret}
          autocomplete="off"
          spellcheck="false"
          placeholder={editing?.hasAppSecret ? "Stored. Paste a new one to replace it" : ""}
        />
      </Field>
    {:else}
      <Field label="Greeting" class="wide">
        <Textarea bind:value={form.greeting} rows={2} maxlength={1000} />
      </Field>
      <Field label="Sites that may embed it (one per line, empty: any allowed by the API)" class="wide" error={errors.allowedOrigins}>
        <Textarea bind:value={form.allowedOrigins} rows={3} spellcheck="false" placeholder="https://www.example.com" />
      </Field>
      <div class="switch">
        <Switch bind:checked={form.preChatForm} label="Ask name and email before the first message" />
      </div>
    {/if}

    <Field label="AI bot (kon-chat)">
      {#if bots}
        <Select bind:value={form.botSlug} options={botOptions} />
      {:else}
        <Input bind:value={form.botSlug} autocomplete="off" spellcheck="false" placeholder="Bot slug" />
      {/if}
    </Field>
    <Field label="Flow">
      {#if flows}
        <Select bind:value={form.flowId} options={flowOptions} />
      {:else}
        <Input bind:value={form.flowId} autocomplete="off" spellcheck="false" placeholder="Flow id" />
      {/if}
    </Field>
    <Field label="Default team">
      <Select bind:value={form.defaultTeamId} options={teamOptions} />
    </Field>
    <Field label="When a resolved conversation is written to again">
      <Select
        bind:value={form.reopenAs}
        options={[
          { value: "", label: "Default" },
          { value: "bot", label: "The bot answers" },
          { value: "queued", label: "It waits for a person" },
        ]}
      />
    </Field>
    <Field label="Resolve after hours without activity" error={errors.autoResolveHours}>
      <Input bind:value={form.autoResolveHours} inputmode="numeric" placeholder="Never" />
    </Field>
    <Field label="Words that ask for a person" class="wide">
      <Input bind:value={form.handoffKeywords} placeholder="agent, human" />
    </Field>
    <Field label="Opt-out words">
      <Input bind:value={form.optOutKeywords} placeholder="STOP" />
    </Field>
    <Field label="Opt-in words">
      <Input bind:value={form.optInKeywords} placeholder="START" />
    </Field>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (formOpen = false)}>{CANCEL}</Button>
      <Button type="submit" loading={saving}>{editing ? "Save" : "Connect"}</Button>
    {/snippet}
  </FormGrid>
</Dialog>

<Dialog bind:open={embedOpen} title={`Embed "${embedFor?.name ?? ""}"`} size="xl" closeLabel={CLOSE}>
  {#if embedFor}
    <div class="embed">
      <p>Paste it before <code>&lt;/body&gt;</code> on every page that shows the chat.</p>
      <pre class="snippet">{snippet(embedFor)}</pre>
      <div class="embed-actions">
        <CopyButton text={snippet(embedFor)} label="Copy code" copyLabel="Copy the embed code" copiedLabel="Copied" />
      </div>
      <p class="hint">The site must be in the API's allowed origins (ALLOWED_ORIGINS) for the chat to reach koe.</p>
    </div>
  {/if}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Disconnect "${deleting?.name ?? ""}"?`}
  description="Its conversations and messages are deleted with it."
  confirmLabel="Disconnect"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .name {
    font-weight: 600;
  }

  .mono {
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
  }

  .detail {
    display: block;
    margin-top: 0.125rem;
    max-width: 24rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .switch {
    flex-basis: 100% !important;
  }

  .embed {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .embed p {
    margin: 0;
  }

  .snippet {
    margin: 0;
    padding: 0.75rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-bg));
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .embed-actions {
    display: flex;
    justify-content: flex-end;
  }

  .hint {
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
