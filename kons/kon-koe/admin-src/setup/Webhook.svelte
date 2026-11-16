<!--
  The Meta webhook: the callback URL and the verify token to type in the Meta app (WhatsApp, Messenger and
  Instagram all post to the same URL). Only the token's hash is stored, so it cannot be shown again: a new
  one replaces it.
-->
<script lang="ts">
  import { Button, CopyButton, DescriptionList, Field, Input, SaveBar } from "$lib/components";

  import type { Api } from "../api";
  import { failed, toast } from "../ui/notify";
  import Panel from "../ui/Panel.svelte";

  const { api, base }: { api: Api; base: string } = $props();

  const callback = $derived(`${base}/webhooks/meta`);

  let token = $state("");
  let saving = $state(false);
  let error = $state("");
  let savedAt = $state<Date | null>(null);

  const dirty = $derived(token.length > 0);

  function generate() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function save() {
    error = token.length < 16 ? "At least 16 characters" : "";
    if (error) return;
    saving = true;
    try {
      await api.put("config/meta", { verifyToken: token });
      toast.success("Verify token saved", { description: "Type the same token in the Meta app now: it cannot be shown again." });
      savedAt = new Date();
    } catch (e) {
      failed("Could not save the verify token", e);
    } finally {
      saving = false;
    }
  }
</script>

<Panel title="Meta webhook" description="Where Meta delivers WhatsApp, Messenger and Instagram messages for every channel.">
  <DescriptionList items={[{ label: "Callback URL", value: callback, copy: true, mono: true }]} />
  <div class="token">
    <Field label="Verify token" error={error || undefined}>
      <Input
        bind:value={token}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
        autocomplete="off" spellcheck="false" minlength={16} maxlength={200} placeholder="A new token replaces the stored one" />
    </Field>
    <div class="row">
      <Button variant="outline" size="sm" onclick={generate}>Generate</Button>
      {#if token}<CopyButton text={token} label="Copy token" copyLabel="Copy the verify token" copiedLabel="Copied" />{/if}
    </div>
    <SaveBar
      {dirty}
      {saving}
      disableWhenClean
      saveLabel="Save token"
      savedText={savedAt ? `Saved at ${savedAt.toLocaleTimeString()}` : "Only its hash is stored"}
      onSave={save}
      onCancel={dirty ? () => (token = "") : undefined}
      cancelLabel="Clear"
      ariaLabel="Save the verify token"
      sticky={false}
    />
  </div>
</Panel>

<style>
  .token {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
</style>
