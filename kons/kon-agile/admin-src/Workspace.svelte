<svelte:options
  customElement={{
    tag: "agile-workspace",
    shadow: "open",
    props: { context: { type: "Object" }, params: { type: "Object" } },
  }}
/>

<!--
  <agile-workspace>: the kon's administration panel.

  It configures and oversees projects (details and automation, members and agents, states,
  labels, estimates and fields, cycles, modules and initiatives, squads and agent schedules),
  decides intakes, watches the agent work queue and audits issues and history. Daily work on
  the board belongs to a frontend or to MCP, not here.

  The admin mounts it with `context` ({ apiBase, theme, locale… }); calls go to the kon's REST
  routes with the browser's cookies. The theme comes from the admin's `--kitsuden-*` variables
  through tallao's ThemeScope.
-->
<script lang="ts">
  import { Alert, Button, Checkbox, Select, Tabs, ThemeScope } from "$lib/components";

  import { createApi } from "./api";
  import NewProjectDialog from "./sections/NewProjectDialog.svelte";
  import Catalog from "./sections/Catalog.svelte";
  import History from "./sections/History.svelte";
  import Intakes from "./sections/Intakes.svelte";
  import Issues from "./sections/Issues.svelte";
  import Members from "./sections/Members.svelte";
  import Planning from "./sections/Planning.svelte";
  import ProjectSettings from "./sections/ProjectSettings.svelte";
  import Team from "./sections/Team.svelte";
  import Work from "./sections/Work.svelte";
  import Workflow from "./sections/Workflow.svelte";
  import { provideWorkspace, Workspace } from "./store.svelte";

  interface ViewContext {
    apiBase?: string;
    theme?: "light" | "dark";
    locale?: string;
  }

  let { context, params }: { context?: ViewContext; params?: unknown } = $props();

  const ws = new Workspace(createApi(() => `${context?.apiBase || "/api"}/agile`));
  provideWorkspace(ws);

  let tab = $state("project");
  let creating = $state(false);

  // The host may set `context` before or after connecting, and again when the theme changes:
  // load once per API base.
  let loadedBase: string | null = null;
  $effect(() => {
    const base = context?.apiBase || "/api";
    if (base === loadedBase) return;
    loadedBase = base;
    ws.loadProjects();
  });

  const tabs = [
    { id: "project", label: "Project" },
    { id: "members", label: "Members" },
    { id: "workflow", label: "States" },
    { id: "catalog", label: "Labels & fields" },
    { id: "planning", label: "Planning" },
    { id: "team", label: "Squads & schedules" },
    { id: "intakes", label: "Intakes" },
    { id: "work", label: "Agent work" },
    { id: "issues", label: "Issues" },
    { id: "history", label: "History" },
  ];

  const projectOptions = $derived(
    ws.projects.map((p) => ({
      value: p.id,
      label: `${p.emoji ? `${p.emoji} ` : ""}${p.name} (${p.identifier})${p.isArchived ? " · archived" : ""}`,
    }))
  );

  let selected = $state("");
  $effect(() => {
    selected = ws.projectId ?? "";
  });
</script>

<ThemeScope class="agile-admin">
  <header class="header">
    <div class="project">
      <Select
        aria-label="Project"
        bind:value={selected}
        options={projectOptions}
        placeholder={ws.projects.length ? undefined : "No projects"}
        disabled={!ws.projects.length}
        onchange={(e: Event) => ws.select((e.currentTarget as HTMLSelectElement).value || null)}
      />
    </div>
    <Checkbox
      checked={ws.showArchived}
      label="Archived"
      onchange={(e: Event) => {
        ws.showArchived = (e.currentTarget as HTMLInputElement).checked;
        ws.loadProjects();
      }}
    />
    <Button size="sm" onclick={() => (creating = true)}>New project</Button>
  </header>

  {#if ws.notice}
    <Alert
      variant={ws.notice.kind}
      dismissLabel="Dismiss"
      onDismiss={() => (ws.notice = null)}
    >
      {ws.notice.text}
    </Alert>
  {/if}

  {#if ws.project}
    <Tabs items={tabs} bind:value={tab} ariaLabel="Project administration">
      {#snippet children(active)}
        {#if active === "project"}
          <ProjectSettings />
        {:else if active === "members"}
          <Members />
        {:else if active === "workflow"}
          <Workflow />
        {:else if active === "catalog"}
          <Catalog />
        {:else if active === "planning"}
          <Planning />
        {:else if active === "team"}
          <Team />
        {:else if active === "intakes"}
          <Intakes />
        {:else if active === "work"}
          <Work />
        {:else if active === "issues"}
          <Issues />
        {:else}
          <History />
        {/if}
      {/snippet}
    </Tabs>
  {:else if !ws.loading}
    <p class="empty">No project</p>
  {/if}

  <NewProjectDialog bind:open={creating} />
</ThemeScope>

<style>
  :host {
    display: block;
  }

  :global(.agile-admin) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .project {
    flex: 1 1 16rem;
    max-width: 28rem;
  }

  .empty {
    margin: 0;
    padding: 2rem;
    text-align: center;
    color: rgb(var(--ta-text-dim));
    border: 1px dashed rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }
</style>
