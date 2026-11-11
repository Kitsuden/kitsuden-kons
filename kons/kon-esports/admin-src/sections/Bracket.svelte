<!--
  Bracket and phases: generate the bracket (or pair the first Swiss round), plan the FGC template,
  start the selected phase and advance to the next one. A button that cannot act is disabled.
-->
<script lang="ts">
  import { Alert, Badge, Button, ToggleGroup } from "$lib/components";

  import { useBooth } from "../store.svelte";
  import Loadable from "../ui/Loadable.svelte";
  import Panel from "../ui/Panel.svelte";

  const booth = useBooth();

  const STATUS: Record<string, string> = { pending: "Pending", active: "Active", complete: "Complete" };

  const options = $derived(
    booth.phases.map((p) => ({
      value: p.id,
      label: [p.name, (p.groups ?? 0) > 1 ? `${p.groups} pools` : null, STATUS[p.status] ?? p.status]
        .filter(Boolean)
        .join(" · "),
    }))
  );
</script>

<Panel title="Bracket and phases">
  {#snippet status()}
    {#if booth.loads.phases.ready}
      <Badge>{booth.phases.length === 1 ? "1 phase" : `${booth.phases.length} phases`}</Badge>
    {/if}
  {/snippet}
  {#snippet actions()}
    <Button
      variant="outline"
      disabled={!booth.phase || booth.phase.status !== "pending"}
      onclick={() => booth.startPhase()}
    >
      Start phase
    </Button>
    <Button
      variant="outline"
      disabled={!booth.phase || booth.phase.status === "pending"}
      onclick={() => booth.advancePhase()}
    >
      Advance to the next
    </Button>
    <Button onclick={() => booth.generate()}>{booth.generateLabel}</Button>
  {/snippet}
  <Loadable
    load={booth.loads.phases}
    errorTitle="The phases did not load"
    lines={2}
    empty={booth.phases.length === 0}
    emptyTitle="No phases planned"
    emptyDescription="The tournament runs as a single bracket."
    actionLabel="Plan the FGC template (pools → top 8)"
    onAction={() => booth.planTemplate()}
  >
    <ToggleGroup
      label="Phase"
      hideLabel={false}
      required
      {options}
      value={booth.activePhase ?? ""}
      onchange={(id) => booth.selectPhase(id)}
    />
  </Loadable>
  {#if booth.notice.phase}
    {@const notice = booth.notice.phase}
    <Alert
      variant={notice.variant}
      title={notice.title}
      dismissLabel="Dismiss"
      onDismiss={() => (booth.notice.phase = null)}>{notice.text}</Alert
    >
  {/if}
</Panel>
