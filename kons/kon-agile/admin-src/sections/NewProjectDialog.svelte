<script lang="ts">
  import { Button, Dialog, Field, Input, Textarea } from "$lib/components";

  import type { Project } from "../types";
  import { optional } from "../format";
  import FormGrid from "../ui/FormGrid.svelte";
  import { CANCEL, CLOSE } from "../ui/labels";
  import { useWorkspace } from "../store.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();
  const ws = useWorkspace();

  let name = $state("");
  let identifier = $state("");
  let description = $state("");
  let emoji = $state("");
  let saving = $state(false);

  const valid = $derived(name.trim() !== "" && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(identifier));

  async function create() {
    saving = true;
    try {
      const project = await ws.act(
        () =>
          ws.api.post<Project>("/projects", {
            name: name.trim(),
            identifier: identifier.toUpperCase(),
            description: optional(description),
            emoji: optional(emoji),
          }),
        "Project created",
        "Could not create the project"
      );
      open = false;
      name = identifier = description = emoji = "";
      await ws.loadProjects(project.id);
    } catch {
      // The toast shows the error; the dialog stays open.
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title="New project" closeLabel={CLOSE} size="lg">
  <FormGrid label="New project" onsubmit={() => valid && !saving && create()}>
    <Field label="Name" required>
      <Input bind:value={name} maxlength={200} />
    </Field>
    <Field label="Key" required error={identifier && !valid && name ? "2-10 letters or digits, starting with a letter" : undefined}>
      <Input bind:value={identifier} maxlength={10} placeholder="PLAT" />
    </Field>
    <Field label="Emoji">
      <Input bind:value={emoji} maxlength={16} />
    </Field>
    <Field label="Description" class="wide">
      <Textarea bind:value={description} rows={3} maxlength={5000} />
    </Field>
  </FormGrid>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{CANCEL}</Button>
    <Button loading={saving} disabled={!valid} onclick={create}>Create</Button>
  {/snippet}
</Dialog>
