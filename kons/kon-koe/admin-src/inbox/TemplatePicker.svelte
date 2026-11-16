<!--
  WhatsApp outside the 24-hour window: only an approved template may go out. Pick one, fill its values (body
  and header placeholders, dynamic link buttons, a copy code, a header file) and read the live preview the
  API renders (POST /templates/:id/preview) before sending it.
-->
<script lang="ts">
  import { Alert, Button, Field, Input, Select, Spinner } from "$lib/components";

  import { ApiError, seg } from "../api";
  import type { Template, TemplateComponent } from "../types";
  import { newKey } from "./format";
  import type { Inbox } from "./store.svelte";
  import { T } from "./strings";

  const { inbox, onSent }: { inbox: Inbox; onSent: () => void } = $props();

  const templates = $derived(inbox.window?.templates ?? []);
  let templateId = $state("");
  $effect(() => {
    if (!templates.some((t) => t.id === templateId)) templateId = templates[0]?.id ?? "";
  });
  const template = $derived(templates.find((t) => t.id === templateId) ?? null);

  const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  const placeholders = (s: string | undefined) => [...new Set([...(s ?? "").matchAll(PLACEHOLDER)].map((m) => m[1]!))];

  /** The values a template needs, the same slots koe.templates.ts reads. */
  function slotsOf(t: Template | null): { slots: Array<{ key: string; label: string }>; headerMedia: TemplateComponent["format"] | null } {
    if (!t) return { slots: [], headerMedia: null };
    const header = t.components.find((c) => c.type === "HEADER");
    const body = t.components.find((c) => c.type === "BODY");
    const buttons = t.components.find((c) => c.type === "BUTTONS")?.buttons ?? [];
    const slots: Array<{ key: string; label: string }> = [];
    const headerText = !header?.format || header.format === "TEXT";
    if (headerText) for (const p of placeholders(header?.text)) slots.push({ key: p, label: `{{${p}}}` });
    for (const p of placeholders(body?.text)) if (!slots.some((s) => s.key === p)) slots.push({ key: p, label: `{{${p}}}` });
    buttons.forEach((b, i) => {
      if (b.type === "URL" && b.url && placeholders(b.url).length) slots.push({ key: `button_${i}`, label: `${b.text} (link)` });
      if (b.type === "COPY_CODE") slots.push({ key: "code", label: b.text || "Code" });
    });
    const media = header?.format && ["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format) ? header.format : null;
    return { slots, headerMedia: media };
  }

  const shape = $derived(slotsOf(template));
  let values = $state<Record<string, string>>({});
  let headerMediaId = $state<string | null>(null);
  let uploading = $state(false);
  let preview = $state("");
  let previewError = $state("");
  let previewing = $state(false);
  let sending = $state(false);
  let error = $state("");
  let key = newKey("tpl");

  $effect(() => {
    void templateId;
    values = {};
    headerMediaId = null;
    key = newKey("tpl");
  });

  // The live preview, a moment after the last keystroke.
  let timer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const id = templateId;
    const v = { ...values };
    const hasMedia = !!headerMediaId;
    if (!id) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      previewing = true;
      try {
        const res = await inbox.api.post<{ data: { preview: string } }>(`templates/${seg(id)}/preview`, { values: v, hasHeaderMedia: hasMedia });
        if (id !== templateId) return;
        preview = res.data.preview;
        previewError = "";
      } catch (e) {
        if (id !== templateId) return;
        preview = "";
        previewError = e instanceof ApiError && e.status === 422 ? `${T.missingValues}. ${e.message}` : e instanceof Error ? e.message : String(e);
      } finally {
        previewing = false;
      }
    }, 300);
  });

  async function upload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !shape.headerMedia) return;
    uploading = true;
    error = "";
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", shape.headerMedia.toLowerCase());
      if (inbox.openId) form.append("conversationId", inbox.openId);
      headerMediaId = (await inbox.api.upload<{ data: { id: string } }>("media", form)).data.id;
    } catch (err) {
      error = `${T.uploadFailed(file.name)}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      uploading = false;
    }
  }

  async function send() {
    if (!template) return;
    sending = true;
    error = "";
    try {
      await inbox.send({ kind: "template", template: { templateId: template.id, values, ...(headerMediaId ? { headerMediaId } : {}) }, idempotencyKey: key });
      key = newKey("tpl");
      values = {};
      headerMediaId = null;
      onSent();
    } catch (e) {
      error = e instanceof ApiError && e.koe ? T.sendErrors[e.koe] ?? e.message : e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
    }
  }
</script>

<div class="picker">
  <p class="why" role="note">{T.windowClosedWhatsApp}</p>
  {#if !templates.length}
    <p class="none">{T.noTemplates}</p>
  {:else}
    <div class="fields">
      <Field label={T.pickTemplate}>
        <Select bind:value={templateId} options={templates.map((t) => ({ value: t.id, label: `${t.name} (${t.language})` }))} />
      </Field>
      {#each shape.slots as s (s.key)}
        <Field label={s.label}>
          <Input value={values[s.key] ?? ""} oninput={(e: Event) => (values = { ...values, [s.key]: (e.currentTarget as HTMLInputElement).value })} />
        </Field>
      {/each}
      {#if shape.headerMedia}
        <Field label={T.headerMedia}>
          <input
            type="file"
            accept={shape.headerMedia === "IMAGE" ? "image/jpeg,image/png" : shape.headerMedia === "VIDEO" ? "video/mp4,video/3gpp" : "*/*"}
            onchange={upload}
            disabled={uploading}
          />
        </Field>
        {#if uploading}<Spinner size="sm" label={T.uploading("")} />{/if}
      {/if}
    </div>
    <div class="preview" aria-live="polite">
      <span class="label">{T.preview}{#if previewing}<Spinner size="sm" label={T.preview} />{/if}</span>
      {#if preview}<p class="text">{preview}</p>{:else if previewError}<p class="dim">{previewError}</p>{/if}
    </div>
    {#if error}<Alert variant="error">{error}</Alert>{/if}
    <div class="actions">
      <Button onclick={send} loading={sending} disabled={!preview || uploading}>{T.sendTemplate}</Button>
    </div>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .why,
  .none {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-warning));
  }

  .none {
    color: rgb(var(--ta-text-dim));
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.5rem;
  }

  .preview {
    padding: 0.5rem 0.75rem;
    border-radius: var(--ta-radius);
    border: 1px dashed rgb(var(--ta-border));
    background: rgb(var(--ta-bg));
  }

  .label {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: rgb(var(--ta-text-dim));
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .text {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
  }

  .dim {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
