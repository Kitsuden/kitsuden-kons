<!-- Points that options consume, and which slots consume them. -->
<script lang="ts">
  import { Badge, Button, Checkbox, EmptyState, Field, Input } from "$lib/components";

  import { useEditor } from "../editor.svelte";
  import FormGrid from "../ui/FormGrid.svelte";
  import Panel from "../ui/Panel.svelte";

  const editor = useEditor();
  const uid = $props.id();

  let id = $state("");
  let name = $state("");
  // A number input gives a number or null: read through String().
  let total = $state("");

  const count = $derived(editor.def.budgets.length);
  const totalNumber = $derived(String(total ?? "").trim() === "" ? NaN : Number(total));
  const canAdd = $derived(id.trim() !== "" && Number.isFinite(totalNumber));

  function add() {
    if (!canAdd) return;
    const budgetId = id.trim();
    editor.def.budgets.push({ id: budgetId, name: name.trim() || budgetId, total: totalNumber, slots: [] });
    id = "";
    name = "";
    total = "";
  }

  // Slots are ticked from a list: pointing at a nonexistent slot is an error the engine rejects.
  function toggle(budget: number, slotId: string, on: boolean) {
    const b = editor.def.budgets[budget];
    const current = new Set(b.slots ?? []);
    if (on) current.add(slotId);
    else current.delete(slotId);
    b.slots = [...current];
  }
</script>

<Panel title="Budgets" description="Points that options cost, and the slots that spend them.">
  {#snippet status()}
    <Badge>{count} {count === 1 ? "budget" : "budgets"}</Badge>
  {/snippet}

  {#if count}
    <div class="budgets">
      {#each editor.def.budgets as budget, i (budget)}
        <section class="budget" aria-label={`Budget ${budget.name}`}>
          <div class="head">
            <div class="title">
              <h3 class="sub">{budget.name}</h3>
              <span class="id">{budget.id}</span>
              <Badge>{budget.total} points</Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              ariaLabel={`Remove budget ${budget.name}`}
              onclick={() => editor.def.budgets.splice(i, 1)}
            >
              Remove
            </Button>
          </div>
          <div class="slots" role="group" aria-labelledby={`${uid}-spent-${i}`}>
            <span class="label" id={`${uid}-spent-${i}`}>Spent by</span>
            {#each editor.def.slots as slot (slot)}
              <Checkbox
                checked={(budget.slots ?? []).includes(slot.id)}
                label={slot.name || slot.id}
                onchange={(e: Event) => toggle(i, slot.id, (e.currentTarget as HTMLInputElement).checked)}
              />
            {:else}
              <span class="none">no slot yet: add slots first</span>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {:else}
    <EmptyState size="sm" level={3} title="No budgets" description="Options cost nothing. Add a budget with the form below." />
  {/if}

  <h3 class="sub add">Add a budget</h3>
  <FormGrid label="Add a budget" onsubmit={add}>
    <Field label="Id" required>
      <Input bind:value={id} placeholder="talents" autocomplete="off" spellcheck="false" />
    </Field>
    <Field label="Name">
      <Input bind:value={name} placeholder="Talent points" autocomplete="off" />
    </Field>
    <Field label="Total points" required>
      <Input bind:value={total} type="number" placeholder="60" />
    </Field>
    {#snippet actions()}
      <Button type="submit" variant="secondary" disabled={!canAdd}>Add budget</Button>
    {/snippet}
  </FormGrid>
</Panel>

<style>
  .budgets {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* One budget of the list, not a card of its own: a rule between budgets. */
  .budget {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  .budget:not(:first-child) {
    padding-top: 1rem;
    border-top: 1px solid rgb(var(--ta-border));
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    min-width: 0;
  }

  .sub {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .sub.add {
    margin-top: 0.5rem;
  }

  .id {
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .slots {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 1rem;
  }

  .label,
  .none {
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
