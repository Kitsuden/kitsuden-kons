/**
 * What every section of the panel shares: the selected project, its members and its states, and
 * the notice under the header. Sections load the rest themselves when the project changes.
 */
import { getContext, setContext } from "svelte";

import { seg, type Api } from "./api";
import type { List, Member, Project, State } from "./types";

export interface Notice {
  kind: "success" | "error";
  text: string;
}

const KEY = Symbol("agile-workspace");

export class Workspace {
  projects = $state<Project[]>([]);
  showArchived = $state(false);
  projectId = $state<string | null>(null);
  project = $state<Project | null>(null);
  members = $state<Member[]>([]);
  states = $state<State[]>([]);
  loading = $state(false);
  notice = $state<Notice | null>(null);
  /** Bumped after a change other sections may show (states, members…), so they reload. */
  version = $state(0);

  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly api: Api) {}

  /** Member options for a Select: agents marked, so nobody assigns an agent by mistake. */
  memberOptions = $derived(
    this.members.map((m) => ({ value: m.userId, label: m.isAgent ? `${m.userId} (agent)` : m.userId }))
  );
  agentOptions = $derived(
    this.members.filter((m) => m.isAgent).map((m) => ({ value: m.userId, label: m.userId }))
  );
  stateOptions = $derived(this.states.map((s) => ({ value: s.id, label: s.name })));

  say(kind: Notice["kind"], text: string) {
    clearTimeout(this.noticeTimer);
    this.notice = { kind, text };
    if (kind === "success") this.noticeTimer = setTimeout(() => (this.notice = null), 4000);
  }

  /** Runs a change and reports it; rethrows so a dialog can stay open on failure. */
  async act<T>(fn: () => Promise<T>, done?: string): Promise<T> {
    try {
      const result = await fn();
      if (done) this.say("success", done);
      return result;
    } catch (e) {
      this.say("error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** Same as `act`, for buttons outside a dialog: the error is already on screen. */
  async run<T>(fn: () => Promise<T>, done?: string): Promise<T | undefined> {
    try {
      return await this.act(fn, done);
    } catch {
      return undefined;
    }
  }

  async loadProjects(selectId?: string) {
    await this.run(async () => {
      const { docs } = await this.api.get<List<Project>>("/projects", {
        isArchived: this.showArchived ? undefined : "false",
      });
      this.projects = docs;
      const keep = selectId ?? this.projectId;
      const next = docs.find((p) => p.id === keep) ?? docs[0] ?? null;
      await this.select(next?.id ?? null);
    });
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
    const id = this.projectId;
    if (!id) return;
    this.loading = true;
    try {
      await this.run(async () => {
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
    } finally {
      this.loading = false;
    }
  }

  memberLabel(userId: string | null | undefined) {
    if (!userId) return "—";
    return this.members.find((m) => m.userId === userId)?.isAgent ? `${userId} (agent)` : userId;
  }

  stateName(id: string | null | undefined) {
    return this.states.find((s) => s.id === id)?.name ?? "—";
  }
}

export const provideWorkspace = (ws: Workspace) => setContext(KEY, ws);
export const useWorkspace = () => getContext<Workspace>(KEY);
