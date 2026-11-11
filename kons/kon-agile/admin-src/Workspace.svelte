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
  through tallao's ThemeScope (ui/View.svelte), which also holds the Toaster every result of an
  action goes to.

  The panel draws the page title, so the view starts at the project bar (which project, and
  "New project" last), then the tabs; each tab holds its sections one under another.
-->
<script lang="ts">
  import { Button, Checkbox, EmptyState, Select, Skeleton, Tabs } from "$lib/components";

  import { createApi } from "./api";
  import Cycles from "./sections/Cycles.svelte";
  import Estimates from "./sections/Estimates.svelte";
  import Fields from "./sections/Fields.svelte";
  import History from "./sections/History.svelte";
  import Initiatives from "./sections/Initiatives.svelte";
  import Intakes from "./sections/Intakes.svelte";
  import Issues from "./sections/Issues.svelte";
  import Labels from "./sections/Labels.svelte";
  import Members from "./sections/Members.svelte";
  import Modules from "./sections/Modules.svelte";
  import NewProjectDialog from "./sections/NewProjectDialog.svelte";
  import ProjectSettings from "./sections/ProjectSettings.svelte";
  import Schedules from "./sections/Schedules.svelte";
  import Squads from "./sections/Squads.svelte";
  import Work from "./sections/Work.svelte";
  import Workflow from "./sections/Workflow.svelte";
  import { provideWorkspace, Workspace } from "./store.svelte";
  import View from "./ui/View.svelte";

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
  let bar = $state<HTMLElement>();

  $effect(() => {
    ws.scope = bar;
  });

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

<View>
  <div class="bar" bind:this={bar}>
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
      label="Show archived"
      onchange={(e: Event) => {
        ws.showArchived = (e.currentTarget as HTMLInputElement).checked;
        ws.loadProjects();
      }}
    />
    <Button onclick={() => (creating = true)}>New project</Button>
  </div>

  {#if ws.list.loading}
    <div class="loading" aria-busy="true">
      <span class="sr-only" role="status">Loading</span>
      <Skeleton height="2.25rem" />
      <Skeleton lines={6} />
    </div>
  {:else if ws.list.error !== null}
    <EmptyState
      variant="error"
      level={2}
      title="Could not load the projects"
      description={ws.list.error}
      onRetry={ws.list.load}
      retrying={ws.list.retrying}
    />
  {:else if !ws.projects.length}
    <EmptyState
      level={2}
      title={ws.showArchived ? "No projects yet" : "No active projects"}
      description="A project holds its members, states, cycles and issues."
      actionLabel="New project"
      onAction={() => (creating = true)}
    />
  {:else if ws.current.error !== null}
    <EmptyState
      variant="error"
      level={2}
      title="Could not load the project"
      description={ws.current.error}
      onRetry={ws.current.load}
      retrying={ws.current.retrying}
    />
  {:else if ws.project}
    <Tabs items={tabs} bind:value={tab} ariaLabel="Project administration">
      {#snippet children(active)}
        <div class="sections">
          {#if active === "project"}
            <ProjectSettings />
          {:else if active === "members"}
            <Members />
          {:else if active === "workflow"}
            <Workflow />
          {:else if active === "catalog"}
            <Labels />
            <Estimates />
            <Fields />
          {:else if active === "planning"}
            <Cycles />
            <Modules />
            <Initiatives />
          {:else if active === "team"}
            <Squads />
            <Schedules />
          {:else if active === "intakes"}
            <Intakes />
          {:else if active === "work"}
            <Work />
          {:else if active === "issues"}
            <Issues />
          {:else}
            <History />
          {/if}
        </div>
      {/snippet}
    </Tabs>
  {/if}

  <NewProjectDialog bind:open={creating} />
</View>

<style>
  :host {
    display: block;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem 1rem;
    flex-wrap: wrap;
  }

  .project {
    flex: 1 1 16rem;
    max-width: 28rem;
    min-width: 0;
  }

  .bar :global(.ta-btn) {
    margin-left: auto;
  }

  /* The sections of a tab, one under another with the view's gap. */
  .sections {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }

  .sections > :global(*) {
    min-width: 0;
    max-width: 100%;
  }

  .loading {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
