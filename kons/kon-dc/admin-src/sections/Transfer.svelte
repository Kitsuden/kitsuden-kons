<!--
  Export / import: the whole bot as one portable file (every blueprint, every server's modules and
  settings; never a token or a key), and loading such a file back, here or in another Kitsuden.
-->
<script lang="ts">
  import { Alert, Button, ConfirmDialog, Field, Textarea } from "$lib/components";

  import { useApi } from "../context";
  import { CANCEL, CLOSE } from "../ui/labels";
  import Panel from "../ui/Panel.svelte";
  import { failed, toast } from "../ui/notify";
  import { fromJson } from "../ui/settings";

  const api = useApi();

  let exporting = $state(false);
  async function exportAll() {
    exporting = true;
    try {
      const file = await api.get<unknown>("/export");
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kitsuden-dc-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export downloaded");
    } catch (e) {
      failed("Could not export", e);
    } finally {
      exporting = false;
    }
  }

  let text = $state("");
  let parseError = $state<string | null>(null);
  let confirmOpen = $state(false);
  let result = $state<{ blueprints: number; guilds: number; modules: number; skipped: string[] } | null>(null);

  async function pick(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 5_000_000) {
      parseError = "The file is larger than 5 MB";
      return;
    }
    text = await file.text();
    parseError = null;
  }

  function ask() {
    const parsed = fromJson(text);
    if (!parsed.ok) {
      parseError = parsed.error;
      return;
    }
    parseError = null;
    confirmOpen = true;
  }

  async function load() {
    const parsed = fromJson(text);
    if (!parsed.ok) return;
    try {
      result = await api.post("/import", parsed.value);
      toast.success("Imported", { description: "Sync each server's commands so Discord sees them." });
    } catch (e) {
      failed("Could not import", e);
    }
  }
</script>

<Panel title="Export">
  {#snippet actions()}
    <Button size="sm" loading={exporting} onclick={exportAll}>Download</Button>
  {/snippet}
  <p class="quiet">Every blueprint and every server's modules and settings. Tokens and keys stay in the environment.</p>
</Panel>

<Panel title="Import">
  {#snippet actions()}
    <Button size="sm" disabled={!text.trim()} onclick={ask}>Import</Button>
  {/snippet}
  <Field label="File">
    <input type="file" accept="application/json,.json" onchange={pick} />
  </Field>
  <Field label="Or paste it" error={parseError ?? undefined}>
    <Textarea bind:value={text} rows={10} mono spellcheck="false" />
  </Field>
  {#if result}
    <Alert variant={result.skipped.length ? "warning" : "success"} title="Imported">
      {result.blueprints} blueprints · {result.guilds} servers · {result.modules} modules
      {#if result.skipped.length}
        <br />Skipped (missing here, or settings that did not validate): <code>{result.skipped.join(", ")}</code>
      {/if}
    </Alert>
  {/if}
</Panel>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Import this file?"
  description="Blueprints with the same id are overwritten, and each server's modules take the file's settings."
  confirmLabel="Import"
  variant="primary"
  cancelLabel={CANCEL}
  closeLabel={CLOSE}
  onConfirm={load}
/>

<style>
  .quiet {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  input[type="file"] {
    font: inherit;
    font-size: 0.8125rem;
  }

  code {
    font-size: 0.75rem;
  }
</style>
