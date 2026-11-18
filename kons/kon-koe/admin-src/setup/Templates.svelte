<!--
  WhatsApp templates: the only messages that may open a conversation or answer after the 24-hour window.
  They live in the WhatsApp Business Account; koe keeps a copy with each one's status (Meta's review moves
  it from pending to approved or rejected), refreshed by Sync and by Meta's webhook.
-->
<script lang="ts">
  import {
    Badge,
    Button,
    ConfirmDialog,
    DataTable,
    Dialog,
    EmptyState,
    Field,
    Input,
    Select,
    Textarea,
    type DataColumn,
  } from "$lib/components";
  import { untrack } from "svelte";

  import { seg, type Api } from "../api";
  import type { Channel, Template, TemplateComponent } from "../types";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { createLoad } from "../ui/load.svelte";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";
  import RowMenu from "../ui/RowMenu.svelte";

  const { api, channels }: { api: Api; channels: Channel[] } = $props();

  const whatsapp = $derived(channels.filter((c) => c.kind === "whatsapp"));
  let channelId = $state("");
  $effect(() => {
    if (!whatsapp.some((c) => c.id === channelId)) channelId = whatsapp[0]?.id ?? "";
  });

  let templates = $state<Template[]>([]);
  const data = createLoad(async () => {
    templates = channelId ? ((await api.get<{ data?: Template[] }>("templates", { channelId })).data ?? []) : [];
  });
  $effect(() => {
    void channelId;
    untrack(data.load);
  });

  const STATUS: Record<Template["status"], { label: string; variant: "success" | "warning" | "error" | "default" | "info" }> = {
    approved: { label: "Approved", variant: "success" },
    pending: { label: "In review", variant: "info" },
    rejected: { label: "Rejected", variant: "error" },
    paused: { label: "Paused", variant: "warning" },
    disabled: { label: "Disabled", variant: "error" },
    in_appeal: { label: "In appeal", variant: "warning" },
    deleted: { label: "Deleted", variant: "default" },
  };

  const textOf = (t: Template, type: TemplateComponent["type"]) => t.components.find((c) => c.type === type)?.text ?? "";

  const columns: DataColumn<Template>[] = [
    { key: "name", header: "Template", sortable: true, hideable: false, filter: "text" },
    { key: "language", header: "Language", sortable: true, filter: "select" },
    { key: "category", header: "Category", sortable: true, filter: "select" },
    { key: "status", header: "Status", sortable: true, filter: "select", value: (t) => STATUS[t.status]?.label ?? t.status },
    { key: "quality", header: "Quality", value: (t) => t.quality ?? "" },
    { key: "body", header: "Text", value: (t) => textOf(t, "BODY") },
  ];

  let syncing = $state(false);
  async function sync() {
    if (!channelId) return;
    syncing = true;
    try {
      await api.post(`channels/${seg(channelId)}/templates/sync`, {});
      toast.success("Templates refreshed from Meta");
      await data.load();
    } catch (e) {
      failed("Could not refresh the templates", e);
    } finally {
      syncing = false;
    }
  }

  // ── New template ────────────────────────────────────────────────────────
  const blank = () => ({ name: "", language: "es", category: "utility" as Template["category"], header: "", body: "", footer: "", quick: "", urlText: "", url: "", examples: "" });
  let form = $state(blank());
  let creating = $state(false);
  let open = $state(false);
  let errors = $state<Record<string, string>>({});

  /** {{1}}, {{2}}… in the body, in order. */
  const slots = $derived([...new Set([...form.body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))]);

  async function create() {
    const e: Record<string, string> = {};
    if (!/^[a-z0-9_]{1,512}$/.test(form.name)) e.name = "Lowercase letters, digits and underscores";
    if (!form.body.trim()) e.body = "Required";
    const examples = form.examples
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (slots.length && examples.length !== slots.length) e.examples = `One example per variable (${slots.length}), separated by commas`;
    if (form.urlText.trim() && !/^https:\/\//.test(form.url.trim())) e.url = "An https:// address";
    errors = e;
    if (Object.keys(e).length) return;

    const components: Array<Record<string, unknown>> = [];
    if (form.header.trim()) components.push({ type: "HEADER", format: "TEXT", text: form.header.trim() });
    components.push({ type: "BODY", text: form.body.trim(), ...(slots.length ? { example: { body_text: [examples] } } : {}) });
    if (form.footer.trim()) components.push({ type: "FOOTER", text: form.footer.trim() });
    const buttons: Array<Record<string, unknown>> = form.quick
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((text) => ({ type: "QUICK_REPLY", text }));
    if (form.urlText.trim()) buttons.push({ type: "URL", text: form.urlText.trim(), url: form.url.trim() });
    if (buttons.length) components.push({ type: "BUTTONS", buttons });

    creating = true;
    try {
      await api.post(`channels/${seg(channelId)}/templates`, { name: form.name, language: form.language.trim(), category: form.category, components });
      toast.success(`${form.name} sent to Meta for review`);
      open = false;
      form = blank();
      await data.load();
    } catch (err) {
      failed("Could not submit the template", err);
    } finally {
      creating = false;
    }
  }

  // ── Viewing and deleting ────────────────────────────────────────────────
  let viewing = $state<Template | null>(null);
  let viewOpen = $state(false);
  let deleting = $state<Template | null>(null);
  let confirmDelete = $state(false);

  async function remove() {
    const t = deleting!;
    try {
      await api.del(`templates/${seg(t.id)}`);
    } catch (e) {
      failed("Could not delete the template", e);
      throw e;
    }
    toast.success(`${t.name} deleted`);
    await data.load();
  }
</script>

<Panel title="WhatsApp templates" description="Approved templates open conversations and answer after the 24-hour window.">
  {#snippet status()}
    {#if data.ready && channelId}<Badge>{templates.length}</Badge>{/if}
  {/snippet}
  {#snippet actions()}
    {#if whatsapp.length > 1}
      <Select
        bind:value={channelId}
        size="sm"
        width="auto"
        aria-label="WhatsApp number"
        options={whatsapp.map((c) => ({ value: c.id, label: c.display ? `${c.name} · ${c.display}` : c.name }))}
      />
    {/if}
    <Button size="sm" variant="outline" loading={syncing} disabled={!channelId} onclick={sync}>Sync from Meta</Button>
    <Button size="sm" disabled={!channelId} onclick={() => (open = true)}>New template</Button>
  {/snippet}
  {#if !whatsapp.length}
    <EmptyState size="sm" level={null} title="No WhatsApp number connected" description="Templates belong to a WhatsApp Business Account: connect a number in Channels." />
  {:else}
    <DataTable caption="Templates" rows={templates} {columns} rowKey="id" rowLabel={(t) => `${t.name} (${t.language})`} loading={data.loading} error={data.error} onRetry={data.load}>
      {#snippet cell(t, col)}
        {#if col.key === "name"}
          <span class="mono">{t.name}</span>
        {:else if col.key === "status"}
          <span title={t.rejectedReason ?? undefined}><Badge variant={STATUS[t.status]?.variant ?? "default"} dot>{STATUS[t.status]?.label ?? t.status}</Badge></span>
          {#if t.rejectedReason}<span class="detail">{t.rejectedReason}</span>{/if}
        {:else if col.key === "body"}
          <span class="body">{textOf(t, "BODY")}</span>
        {:else}
          {col.value?.(t)}
        {/if}
      {/snippet}
      {#snippet rowActions(t)}
        <RowMenu
          label={`Actions: ${t.name}`}
          items={[
            {
              label: "View",
              onSelect: () => {
                viewing = t;
                viewOpen = true;
              },
            },
            {
              label: "Delete",
              danger: true,
              separated: true,
              disabled: t.status === "deleted",
              onSelect: () => {
                deleting = t;
                confirmDelete = true;
              },
            },
          ]}
        />
      {/snippet}
      {#snippet empty()}
        <EmptyState size="sm" level={null} title="No templates here yet" description="Sync the ones the account already has, or submit a new one." actionLabel="Sync from Meta" onAction={sync} />
      {/snippet}
    </DataTable>
  {/if}
</Panel>

<Dialog bind:open title="New template" description="Meta reviews it before it can be sent; it shows as In review until then." size="xl" closeLabel={CLOSE}>
  <FormGrid label="New template" onsubmit={create}>
    <Field label="Name" required error={errors.name}>
      <Input bind:value={form.name} spellcheck="false" autocomplete="off" placeholder="payment_reminder" />
    </Field>
    <Field label="Language" required>
      <Input bind:value={form.language} spellcheck="false" placeholder="es" />
    </Field>
    <Field label="Category">
      <Select
        bind:value={form.category}
        options={[
          { value: "utility", label: "Utility" },
          { value: "marketing", label: "Marketing" },
          { value: "authentication", label: "Authentication" },
        ]}
      />
    </Field>
    <Field label="Header" class="wide">
      <Input bind:value={form.header} maxlength={60} />
    </Field>
    <Field label={"Body ({{1}}, {{2}}… for variables)"} required error={errors.body} class="wide">
      <Textarea bind:value={form.body} rows={4} maxlength={1024} />
    </Field>
    {#if slots.length}
      <Field label={`Examples for ${slots.map((s) => `{{${s}}}`).join(", ")}`} error={errors.examples} class="wide">
        <Input bind:value={form.examples} placeholder="Lucía, 15 de mayo" />
      </Field>
    {/if}
    <Field label="Footer" class="wide">
      <Input bind:value={form.footer} maxlength={60} />
    </Field>
    <Field label="Quick reply buttons (up to 3, comma separated)" class="wide">
      <Input bind:value={form.quick} placeholder="Yes, No" />
    </Field>
    <Field label="Link button text">
      <Input bind:value={form.urlText} maxlength={25} />
    </Field>
    <Field label="Link button address" error={errors.url}>
      <Input bind:value={form.url} type="url" spellcheck="false" placeholder="https://" />
    </Field>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
      <Button type="submit" loading={creating}>Submit to Meta</Button>
    {/snippet}
  </FormGrid>
</Dialog>

<Dialog bind:open={viewOpen} title={viewing ? `${viewing.name} (${viewing.language})` : ""} size="lg" closeLabel={CLOSE}>
  {#if viewing}
    <div class="preview">
      {#each viewing.components as c, i (i)}
        {#if c.type === "BUTTONS"}
          <div class="buttons">
            {#each c.buttons ?? [] as b, j (j)}<span class="button">{b.text}</span>{/each}
          </div>
        {:else if c.text}
          <p class={c.type.toLowerCase()}>{c.text}</p>
        {:else if c.format}
          <p class="header">[{c.format.toLowerCase()}]</p>
        {/if}
      {/each}
    </div>
  {/if}
</Dialog>

<ConfirmDialog
  bind:open={confirmDelete}
  title={`Delete ${deleting?.name ?? ""}?`}
  description="It is deleted in Meta in every language, and cannot be sent again."
  confirmLabel="Delete"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  variant="danger"
  onConfirm={remove}
/>

<style>
  .mono {
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
  }

  .detail {
    display: block;
    margin-top: 0.125rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .body {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    max-width: 28rem;
  }

  .preview {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
  }

  .preview p {
    margin: 0;
    white-space: pre-wrap;
  }

  .preview .header {
    font-weight: 600;
  }

  .preview .footer {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .button {
    padding: 0.25rem 0.625rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: 999px;
    font-size: 0.8125rem;
    color: rgb(var(--ta-accent-hover));
  }
</style>
