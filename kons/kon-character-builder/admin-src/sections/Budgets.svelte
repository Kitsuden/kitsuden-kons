<!-- Points that options consume, and which slots consume them. -->
<script lang="ts">
  import { Button, Checkbox, Input } from "$lib/components";

  import { useEditor } from "../editor.svelte";
  import Panel from "../ui/Panel.svelte";

  const editor = useEditor();

  let id = $state("");
  let name = $state("");
  // A number input gives a number or null: read through String().
  let total = $state("");

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

  function key(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
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

<Panel title="Budgets">
  {#if editor.def.budgets.length}
    <div class="budgets">
      {#each editor.def.budgets as budget, i (budget)}
        <div class="budget">
          <div class="head">
            <span class="title">{budget.name} ({budget.id}) — {budget.total}</span>
            <Button
              variant="ghost"
              size="sm"
              ariaLabel={`Remove ${budget.id}`}
              onclick={() => editor.def.budgets.splice(i, 1)}
            >
              Remove
            </Button>
          </div>
          <div class="slots" role="group" aria-label={`Slots that consume ${budget.name}`}>
            {#each editor.def.slots as slot (slot)}
              <Checkbox
                checked={(budget.slots ?? []).includes(slot.id)}
                label={slot.name || slot.id}
                onchange={(e: Event) => toggle(i, slot.id, (e.currentTarget as HTMLInputElement).checked)}
              />
            {:else}
              <p class="empty">Add slots and you will be able to assign them here.</p>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <p class="empty">No budgets. Options will cost nothing.</p>
  {/if}

  <div class="new">
    <div class="field">
      <Input bind:value={id} placeholder="talentos" aria-label="Budget id" autocomplete="off" onkeydown={key} />
    </div>
    <div class="field wide">
      <Input bind:value={name} placeholder="Talent points" aria-label="Budget name" autocomplete="off" onkeydown={key} />
    </div>
    <div class="field">
      <Input bind:value={total} type="number" placeholder="60" aria-label="Total points" onkeydown={key} />
    </div>
    <Button variant="secondary" size="sm" disabled={!canAdd} onclick={add}>Add budget</Button>
  </div>
</Panel>

<style>
  .budgets {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .budget {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-bg));
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .title {
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
  }

  .slots {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
  }

  .new {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .field {
    flex: 0 1 9rem;
    min-width: 7rem;
  }

  .field.wide {
    flex: 1 1 12rem;
  }

  .empty {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
