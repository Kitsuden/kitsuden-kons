/**
 * What every section of the panel shares: the list of projects, the selected one with its
 * members and states, and how a change is run and reported. Sections load the rest themselves
 * when the project changes.
 */
import { getContext, setContext } from "svelte";

import { seg, type Api } from "./api";
import type { List, Member, Project, State } from "./types";
import { tokenHex } from "./ui/color";
import { createLoad } from "./ui/load.svelte";
import { failed, toast } from "./ui/notify";

const KEY = Symbol("agile-workspace");

export class Workspace {
  projects = $state<Project[]>([]);
  showArchived = $state(false);
  projectId = $state<string | null>(null);
  project = $state<Project | null>(null);
  members = $state<Member[]>([]);
  states = $state<State[]>([]);
  /** Bumped after a change other sections may show (states, members…), so they reload. */
  version = $state(0);
  /** An element inside the view's ThemeScope: where the theme's colours are read. */
  scope: HTMLElement | undefined;

  /** The project to select once the list is back (the one just created). */
  private wanted: string | undefined;

  constructor(readonly api: Api) {}

  /** The list of projects: loading, ready or failed. */
  readonly list = createLoad(async () => {
    const { docs } = await this.api.get<List<Project>>("/projects", {
      isArchived: this.showArchived ? undefined : "false",
    });
    this.projects = docs;
    const keep = this.wanted ?? this.projectId;
    this.wanted = undefined;
    const next = docs.find((p) => p.id === keep) ?? docs[0] ?? null;
    await this.select(next?.id ?? null);
  });

  /** The selected project with its members and states: loading, ready or failed. */
  readonly current = createLoad(async () => {
    const id = this.projectId;
    if (!id) return;
    const [project, members] = await Promise.all([
      this.api.get<Project>(`/projects/${seg(id)}`),
      this.api.get<List<Member>>(`/projects/${seg(id)}/members`),
    ]);
    if (this.projectId !== id) return;
    this.project = project;
    this.states = [...(project.states ?? [])].sort((a, b) => a.sequence - b.sequence);
    this.members = members.docs;
    this.version++;
  });

  /** Member options for a Select: agents marked, so nobody assigns an agent by mistake. */
  memberOptions = $derived(
    this.members.map((m) => ({ value: m.userId, label: m.isAgent ? `${m.userId} (agent)` : m.userId }))
  );
  agentOptions = $derived(
    this.members.filter((m) => m.isAgent).map((m) => ({ value: m.userId, label: m.userId }))
  );
  stateOptions = $derived(this.states.map((s) => ({ value: s.id, label: s.name })));

  /**
   * Runs a change and reports it in a toast: `done` when it worked, `what` ("Could not save the
   * label") with the API's message when it failed. Rethrows so a dialog can stay open.
   */
  async act<T>(fn: () => Promise<T>, done: string | undefined, what: string): Promise<T> {
    try {
      const result = await fn();
      if (done) toast.success(done);
      return result;
    } catch (e) {
      failed(what, e);
      throw e;
    }
  }

  /** Same as `act`, for buttons outside a dialog: the failure is already in its toast. */
  async run<T>(fn: () => Promise<T>, done: string | undefined, what: string): Promise<T | undefined> {
    try {
      return await this.act(fn, done, what);
    } catch {
      return undefined;
    }
  }

  async loadProjects(selectId?: string) {
    this.wanted = selectId;
    await this.list.load();
  }

  async select(id: string | null) {
    this.projectId = id;
    if (!id) {
      this.project = null;
      this.members = [];
      this.states = [];
      return;
    }
    await this.reloadProject();
  }

  async reloadProject() {
    if (!this.projectId) return;
    await this.current.load();
  }

  memberLabel(userId: string | null | undefined) {
    if (!userId) return "—";
    return this.members.find((m) => m.userId === userId)?.isAgent ? `${userId} (agent)` : userId;
  }

  stateName(id: string | null | undefined) {
    return this.states.find((s) => s.id === id)?.name ?? "—";
  }

  /** The colour a new project starts with: the theme's accent. */
  accentColor() {
    return tokenHex(this.scope, "--ta-accent");
  }

  /** The colour a new state, label, module or initiative starts with: the theme's neutral. */
  neutralColor() {
    return tokenHex(this.scope, "--ta-subtle");
  }
}

export const provideWorkspace = (ws: Workspace) => setContext(KEY, ws);
export const useWorkspace = () => getContext<Workspace>(KEY);
