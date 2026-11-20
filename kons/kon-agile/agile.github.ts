/**
 * kon-agile — GitHub pull requests on issues (1.4)
 * ============================================================================
 *
 * A project connects a repository; GitHub posts its pull request events to the kon. A pull request
 * that names an issue key (`PLAT-12`) in its title, description or branch is listed on that issue,
 * and one that says it closes it (`fixes PLAT-12`, `closes`, `resolves`) moves the issue to the
 * project's first completed state when it is merged (unless the repository says otherwise).
 *
 * Nothing is read from GitHub: the kon only receives. So there is no token to store, only the
 * webhook secret GitHub signs with:
 *
 *   · it is generated here, shown ONCE when the repository is connected, and stored sealed with
 *     `ctx.secrets` (`agile_github_repos.webhook_secret`, declared in `secretColumns`);
 *   · every delivery must carry `X-Hub-Signature-256`, the HMAC-SHA256 of the raw body with that
 *     secret; anything else is a 401 and changes nothing;
 *   · the payload's repository must be the connected one (a secret leaked for one repository does
 *     not post for another);
 *   · without `ctx.secrets` (no secrets key on the server) a repository cannot be connected.
 *
 * Connecting a repository is configuration: a person with write rights, never an agent.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { AppError, asSystem, isUuid, type AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import type { AgileAccess } from "./agile.access";
import type { AgileDb } from "./agile.db";
import {
  agileGithubRepos,
  agileIssuePullRequests,
  agileIssues,
  agileProjects,
  agileStates,
  type AgileGithubRepo,
} from "./agile.schema";
import { SYSTEM_ACTOR, type AgileWorkflow } from "./agile.workflow";
import { declareOp, KeyParam, ListWithTotal, ProjectParam, Row, Success, KON_ID, registry } from "./operations";

const repoName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "owner/name, e.g. acme/website")
  .describe("The repository, owner/name");
const connectSchema = z.object({
  repo: repoName,
  closeOnMerge: z.boolean().optional().describe("Merging a pull request that says `fixes KEY` completes the issue (default true)"),
});
const patchSchema = z.object({ closeOnMerge: z.boolean() });
const RepoParam = z.object({ repoId: z.string().describe("Connected repository id (uuid)") });

const MAX_BODY = 1_000_000;

/** Columns of a repository that may leave the kon: never the sealed secret. */
const publicColumns = {
  id: agileGithubRepos.id,
  projectId: agileGithubRepos.projectId,
  repo: agileGithubRepos.repo,
  closeOnMerge: agileGithubRepos.closeOnMerge,
  createdBy: agileGithubRepos.createdBy,
  lastDeliveryAt: agileGithubRepos.lastDeliveryAt,
  createdAt: agileGithubRepos.createdAt,
};

/** Issue keys of a project named in a text, and which of them it says it closes. */
export function keysIn(identifier: string, texts: (string | null | undefined)[]) {
  const ident = identifier.replace(/[^A-Za-z0-9]/g, "");
  const mention = new RegExp(`(?<![A-Za-z0-9])(${ident}-\\d{1,9})(?![A-Za-z0-9])`, "gi");
  const closing = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(${ident}-\\d{1,9})(?![A-Za-z0-9])`,
    "gi"
  );
  const mentioned = new Set<string>();
  const closes = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    const text = t.slice(0, 20_000);
    for (const m of text.matchAll(mention)) mentioned.add(m[1].toUpperCase());
    for (const m of text.matchAll(closing)) closes.add(m[1].toUpperCase());
  }
  for (const k of closes) mentioned.add(k);
  return { mentioned: [...mentioned], closes };
}

/** `sha256=<hex>` against the HMAC of the raw body; constant time. */
export function signatureMatches(secret: string, raw: ArrayBuffer, header: string | undefined | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(Buffer.from(raw)).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice(7), "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface PullRequestEvent {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    state?: string;
    merged?: boolean;
    user?: { login?: string };
    head?: { ref?: string };
  };
}

export function githubOperations(
  db: { instance: AgileDb },
  access: AgileAccess,
  workflow: AgileWorkflow,
  ctx: Pick<KonContext, "secrets" | "config" | "logger">
): AnyOperation[] {
  const routes = registry();
  const { projectFor, projectToConfigure, issueFor } = access;

  /** The API's origin without trailing slashes (a loop, not a regex: CodeQL js/polynomial-redos). */
  const origin = () => {
    let url = ctx.config?.siteUrl ?? "";
    while (url.endsWith("/")) url = url.slice(0, -1);
    return url;
  };
  const webhookUrl = (id: string) => `${origin()}/api/agile/github/webhook/${id}`;

  async function repoToConfigure(c: Parameters<typeof projectFor>[0], repoId: string) {
    if (!isUuid(repoId)) throw AppError.notFound("Repository not found");
    const [row] = await db.instance.select(publicColumns).from(agileGithubRepos).where(eq(agileGithubRepos.id, repoId)).limit(1);
    if (!row) throw AppError.notFound("Repository not found");
    try {
      await projectToConfigure(c, row.projectId);
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Repository not found");
      throw e;
    }
    return row;
  }

  routes.get(
    "/:projectId/github",
    {
      ...declareOp("list-github-repos", "Repositories connected to a project", "Each connected repository with its webhook URL, whether merging closes issues, and when GitHub last delivered. The secret is never shown again. Only for members of the project (and admin); anyone else gets 404.", { params: ProjectParam }, { schema: ListWithTotal }),
      unpaginated: "Configuration of one project: the GitHub repositories a person connected to it, one at a time; a few per project.",
    },
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const rows = await db.instance
        .select(publicColumns)
        .from(agileGithubRepos)
        .where(eq(agileGithubRepos.projectId, project.id))
        .orderBy(asc(agileGithubRepos.repo));
      const docs = rows.map((r) => ({ ...r, webhookUrl: webhookUrl(r.id) }));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  routes.post(
    "/:projectId/github",
    declareOp("connect-github-repo", "Connect a GitHub repository", "Connects `owner/name` to the project and answers the webhook URL and secret to paste in GitHub (Settings → Webhooks: content type `application/json`, the secret, event \"Pull requests\"). The secret is shown only in this answer and stored sealed. 409 if the repository is already connected to the project, or if the server has no secrets key. Owner or member of the project, never an agent (viewer or agent: 403; non-member: 404).", { params: ProjectParam, body: connectSchema }, { status: 201, schema: Row }, ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"]),
    async (c, input) => {
      const { project, user } = await projectToConfigure(c, input.params.projectId);
      if (!ctx.secrets) {
        throw AppError.conflict("This server has no secrets key (KITSUDEN_SECRETS_KEY), so it cannot keep a webhook secret");
      }
      const body: z.infer<typeof connectSchema> = input.body;
      const repo = body.repo.toLowerCase();
      const [already] = await db.instance
        .select({ id: agileGithubRepos.id })
        .from(agileGithubRepos)
        .where(and(eq(agileGithubRepos.projectId, project.id), eq(agileGithubRepos.repo, repo)))
        .limit(1);
      if (already) throw AppError.conflict("That repository is already connected to this project");
      const secret = randomBytes(32).toString("hex");
      const [row] = await db.instance
        .insert(agileGithubRepos)
        .values({
          projectId: project.id,
          repo,
          webhookSecret: ctx.secrets.seal(KON_ID, secret),
          closeOnMerge: body.closeOnMerge ?? true,
          createdBy: user.id,
        })
        .returning(publicColumns);
      await access.logActivity({ actorId: user.id, projectId: project.id, entityType: "github", entityId: row.id, action: "connected", description: repo });
      return c.json(
        {
          ...row,
          webhookUrl: webhookUrl(row.id),
          webhookSecret: secret,
          setup: "In GitHub: Settings → Webhooks → Add webhook. Payload URL: webhookUrl; content type: application/json; secret: webhookSecret; events: Pull requests. The secret is not shown again.",
        },
        201
      );
    }
  );

  routes.patch(
    "/github/:repoId",
    declareOp("update-github-repo", "Change a connected repository", "Whether merging a pull request that says `fixes KEY` completes the issue. Owner or member of the project, never an agent.", { params: RepoParam, body: patchSchema }, { schema: Row }),
    async (c, input) => {
      const repo = await repoToConfigure(c, input.params.repoId);
      const [row] = await db.instance
        .update(agileGithubRepos)
        .set({ closeOnMerge: input.body.closeOnMerge })
        .where(eq(agileGithubRepos.id, repo.id))
        .returning(publicColumns);
      return c.json({ ...row, webhookUrl: webhookUrl(row.id) });
    }
  );

  routes.delete(
    "/github/:repoId",
    declareOp("disconnect-github-repo", "Disconnect a repository", "Deliveries for it are refused from now on and its pull requests leave the issues. Remove the webhook in GitHub too. Owner or member of the project, never an agent.", { params: RepoParam }, { schema: Success }),
    async (c, input) => {
      const repo = await repoToConfigure(c, input.params.repoId);
      await db.instance.delete(agileGithubRepos).where(eq(agileGithubRepos.id, repo.id));
      return c.json({ success: true });
    }
  );

  routes.get(
    "/issues/:key/pull-requests",
    {
      ...declareOp("list-pull-requests", "Pull requests of an issue", "The GitHub pull requests that mention the issue: repository, number, title, URL, state (open, closed, merged), author and whether it closes the issue. Only for members of the project (and admin); anyone else gets 404.", { params: KeyParam }, { schema: ListWithTotal }),
      unpaginated: "The pull requests that mention ONE issue, one row per pull request however often it changes: a few per issue.",
    },
    async (c, input) => {
      const { issue } = await issueFor(c, input.params.key, "view");
      const docs = await db.instance
        .select({
          id: agileIssuePullRequests.id,
          repo: agileGithubRepos.repo,
          number: agileIssuePullRequests.number,
          title: agileIssuePullRequests.title,
          url: agileIssuePullRequests.url,
          state: agileIssuePullRequests.state,
          author: agileIssuePullRequests.author,
          closesIssue: agileIssuePullRequests.closesIssue,
          updatedAt: agileIssuePullRequests.updatedAt,
        })
        .from(agileIssuePullRequests)
        .innerJoin(agileGithubRepos, eq(agileIssuePullRequests.repoId, agileGithubRepos.id))
        .where(eq(agileIssuePullRequests.issueId, issue.id))
        .orderBy(asc(agileIssuePullRequests.createdAt));
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  /** Applies one verified pull request event: links, state, and the completion on merge. */
  async function applyPullRequest(repo: AgileGithubRepo, event: PullRequestEvent) {
    const pr = event.pull_request;
    if (!pr?.number || !pr.html_url) return { linked: [] as string[], completed: [] as string[] };
    const [project] = await db.instance.select().from(agileProjects).where(eq(agileProjects.id, repo.projectId)).limit(1);
    if (!project) return { linked: [], completed: [] };
    const { mentioned, closes } = keysIn(project.identifier, [pr.title, pr.body, pr.head?.ref]);
    if (!mentioned.length) return { linked: [], completed: [] };

    const issues = await db.instance
      .select()
      .from(agileIssues)
      .where(and(eq(agileIssues.projectId, project.id), inArray(sql`upper(${agileIssues.key})`, mentioned)));
    const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    const linked: string[] = [];
    const completed: string[] = [];

    let doneState: string | null | undefined;
    for (const issue of issues) {
      const closesIssue = closes.has(issue.key.toUpperCase());
      await db.instance
        .insert(agileIssuePullRequests)
        .values({
          issueId: issue.id,
          repoId: repo.id,
          number: pr.number,
          title: (pr.title ?? "").slice(0, 500),
          url: pr.html_url,
          state,
          author: pr.user?.login ?? null,
          closesIssue,
        })
        .onConflictDoUpdate({
          target: [agileIssuePullRequests.issueId, agileIssuePullRequests.repoId, agileIssuePullRequests.number],
          set: { title: (pr.title ?? "").slice(0, 500), state, closesIssue, updatedAt: new Date() },
        });
      linked.push(issue.key);
      await access.logActivity({
        actorId: SYSTEM_ACTOR,
        projectId: project.id,
        issueId: issue.id,
        entityType: "pull_request",
        entityId: repo.id,
        action: `pull_request_${state}`,
        description: `${repo.repo}#${pr.number} ${pr.title ?? ""}`.slice(0, 500),
      });
      workflow.emit("agile:pull_request.linked", {
        projectId: project.id,
        issueId: issue.id,
        key: issue.key,
        repo: repo.repo,
        number: pr.number,
        url: pr.html_url,
        state,
      });

      if (state === "merged" && closesIssue && repo.closeOnMerge && !issue.completedAt && !issue.cancelledAt) {
        if (doneState === undefined) {
          const [s] = await db.instance
            .select({ id: agileStates.id })
            .from(agileStates)
            .where(and(eq(agileStates.projectId, project.id), eq(agileStates.group, "completed")))
            .orderBy(asc(agileStates.sequence))
            .limit(1);
          doneState = s?.id ?? null;
        }
        if (!doneState) continue;
        let values: Awaited<ReturnType<typeof workflow.prepareIssue>>;
        try {
          // prepareIssue only reads, so catching here never leaves the transaction aborted.
          values = await workflow.prepareIssue(project, issue, { stateId: doneState, updatedAt: new Date() }, false);
        } catch (e) {
          // A state that asks for an assignee or an estimate the issue lacks: it stays as it is.
          ctx.logger?.warn("📋 Agile: merged pull request could not complete the issue", {
            key: issue.key,
            message: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        const [after] = await db.instance.update(agileIssues).set(values).where(eq(agileIssues.id, issue.id)).returning();
        await workflow.afterIssue(project, { id: SYSTEM_ACTOR }, issue, after);
        completed.push(issue.key);
      }
    }
    return { linked, completed };
  }

  routes.post(
    "/github/webhook/:repoId",
    {
      ...declareOp(
        "github-webhook",
        "GitHub webhook (pull requests)",
        "Where GitHub posts the events of a connected repository. Requires `X-Hub-Signature-256` with the repository's secret (401 otherwise) and the connected repository in the payload (422 otherwise). Handles `ping` and `pull_request`; other events are accepted and ignored. Not for people or agents.",
        { params: RepoParam },
        { schema: z.object({ ok: z.literal(true) }).passthrough() },
        ["KITSUDEN_E_NOT_FOUND"]
      ),
      access: "public",
      permission: undefined,
      mcp: { exclude: "Called by GitHub with a signature, not by agents" },
    },
    async (c, input) => {
      const repoId = input.params.repoId;
      if (!isUuid(repoId) || !ctx.secrets) return c.json({ error: "Unknown repository" }, 404);
      const lengthHeader = Number(c.req.header("content-length") ?? 0);
      if (lengthHeader > MAX_BODY) return c.json({ error: "Payload too large" }, 413);
      const raw = await c.req.arrayBuffer();
      if (raw.byteLength > MAX_BODY) return c.json({ error: "Payload too large" }, 413);

      return asSystem(async () => {
        const [repo] = await db.instance.select().from(agileGithubRepos).where(eq(agileGithubRepos.id, repoId)).limit(1);
        if (!repo) return c.json({ error: "Unknown repository" }, 404);
        const secret = await ctx.secrets!.open(KON_ID, repo.webhookSecret as never, {
          purpose: "verify-github-webhook",
          subject: `github-repo:${repo.id}`,
        });
        if (!signatureMatches(secret, raw, c.req.header("x-hub-signature-256"))) {
          return c.json({ error: "Bad signature" }, 401);
        }
        let event: PullRequestEvent;
        try {
          event = JSON.parse(Buffer.from(raw).toString("utf8")) as PullRequestEvent;
        } catch {
          return c.json({ error: "Invalid JSON" }, 400);
        }
        const name = c.req.header("x-github-event") ?? "";
        if (name !== "ping" && (event.repository?.full_name ?? "").toLowerCase() !== repo.repo) {
          return c.json({ error: "This webhook belongs to another repository" }, 422);
        }
        await db.instance.update(agileGithubRepos).set({ lastDeliveryAt: new Date() }).where(eq(agileGithubRepos.id, repo.id));
        if (name !== "pull_request") return c.json({ ok: true, event: name, ignored: name !== "ping" });
        const result = await applyPullRequest(repo, event);
        return c.json({ ok: true, event: name, ...result });
      });
    }
  );

  return routes.ops;
}
