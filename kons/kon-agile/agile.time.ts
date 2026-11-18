/**
 * kon-agile — logged time and what an issue cost (1.4)
 * ============================================================================
 *
 * A person (or an agent) logs minutes on an issue in its reach. Next to what agents already report
 * when they finish a piece of work (tokens and USD, `agile_agent_work`), that gives the whole cost of
 * an issue: the people's hours at the project's `config.hourlyRateUsd`, plus the agents' runs.
 *
 * Who may do what (also in the database, migration 0006):
 *   · log time: a writer on an issue in its reach, always as itself;
 *   · fix or remove an entry: its author, or a person with write rights in the project;
 *   · read: any member of the project.
 */

import { AppError, isUuid, type AnyOperation } from "@kitsuden/engine";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { isAgent, type AgileAccess } from "./agile.access";
import type { AgileDb } from "./agile.db";
import { agileAgentWork, agileIssues, agileTimeEntries } from "./agile.schema";
import { declareOp, KeyParam, ListWithTotal, ProjectParam, Row, Success, query, registry, text } from "./operations";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const logSchema = z.object({
  minutes: z.number().int().min(1).max(1440).describe("Minutes spent (1 to 1440)"),
  spentOn: day.optional().describe("Day the time was spent, YYYY-MM-DD (default: today, UTC)"),
  note: z.string().max(2000).optional(),
});
const patchSchema = logSchema.partial();
const EntryParam = z.object({ entryId: z.string().describe("Time entry id (uuid)") });

const today = () => new Date().toISOString().slice(0, 10);
const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

export function timeOperations(db: { instance: AgileDb }, access: AgileAccess): AnyOperation[] {
  const routes = registry();
  const { issueFor, issueToWrite, projectFor, userValue } = access;

  const WHO_SEES = "Only for members of the project (and admin); anyone else gets 404.";

  /** Minutes per person, and the people's cost at the project's hourly rate. */
  async function peopleTime(issueId: string, rate: number | null | undefined) {
    const rows = await db.instance
      .select({ userId: agileTimeEntries.userId, minutes: sql<number>`sum(${agileTimeEntries.minutes})::int` })
      .from(agileTimeEntries)
      .where(eq(agileTimeEntries.issueId, issueId))
      .groupBy(agileTimeEntries.userId);
    const minutes = rows.reduce((n, r) => n + Number(r.minutes), 0);
    const hasRate = typeof rate === "number" && rate >= 0;
    return {
      minutes,
      hours: round(minutes / 60, 2),
      costUsd: hasRate ? round((minutes / 60) * rate) : null,
      byUser: rows.map((r) => ({ userId: r.userId, minutes: Number(r.minutes) })),
    };
  }

  /** What the agents reported for the work queued on this issue. */
  async function agentCost(issueId: string) {
    const [row] = await db.instance
      .select({
        runs: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${agileAgentWork.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${agileAgentWork.outputTokens}), 0)::bigint`,
        costUsd: sql<string>`coalesce(sum(${agileAgentWork.costUsd}), 0)`,
      })
      .from(agileAgentWork)
      .where(and(eq(agileAgentWork.issueId, issueId), inArray(agileAgentWork.status, ["done", "failed"])));
    return {
      runs: Number(row?.runs ?? 0),
      inputTokens: Number(row?.inputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
      costUsd: round(Number(row?.costUsd ?? 0)),
    };
  }

  routes.get(
    "/issues/:key/time",
    declareOp("list-time", "Time logged on an issue", `Every entry (newest day first) and the total minutes. ${WHO_SEES}`, { params: KeyParam }, { schema: ListWithTotal.extend({ totalMinutes: z.number().int() }).passthrough() }),
    async (c, input) => {
      const { issue } = await issueFor(c, input.params.key, "view");
      const docs = await db.instance
        .select()
        .from(agileTimeEntries)
        .where(eq(agileTimeEntries.issueId, issue.id))
        .orderBy(desc(agileTimeEntries.spentOn), desc(agileTimeEntries.createdAt));
      return c.json({ docs, totalDocs: docs.length, totalMinutes: docs.reduce((n, d) => n + d.minutes, 0) });
    }
  );

  routes.post(
    "/issues/:key/time",
    declareOp("log-time", "Log time on an issue", "Logs minutes the caller spent on the issue (1-1440 per entry, a day as YYYY-MM-DD). Always as the caller. Owner or member of the project; an agent only on issues in its reach (viewer: 403; non-member: 404).", { params: KeyParam, body: logSchema }, { status: 201, schema: Row }),
    async (c, input) => {
      const { issue, project, user } = await issueToWrite(c, input.params.key);
      const body: z.infer<typeof logSchema> = input.body;
      const [row] = await db.instance
        .insert(agileTimeEntries)
        .values({ projectId: project.id, issueId: issue.id, userId: user.id, minutes: body.minutes, spentOn: body.spentOn ?? today(), note: body.note })
        .returning();
      await access.logActivity({ actorId: user.id, projectId: project.id, issueId: issue.id, entityType: "time", entityId: row.id, action: "time_logged", description: `${row.minutes} min on ${row.spentOn}` });
      return c.json(row, 201);
    }
  );

  async function entryToChange(c: Parameters<typeof userValue>[0], entryId: string) {
    if (!isUuid(entryId)) throw AppError.notFound("Time entry not found");
    const [entry] = await db.instance.select().from(agileTimeEntries).where(eq(agileTimeEntries.id, entryId)).limit(1);
    if (!entry) throw AppError.notFound("Time entry not found");
    try {
      const { user } = await projectFor(c, entry.projectId, entry.userId === userValue(c).id ? "view" : "write");
      if (entry.userId !== user.id && isAgent(user)) throw AppError.forbidden("An agent changes only its own time");
      return { entry, user };
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw AppError.notFound("Time entry not found");
      throw e;
    }
  }

  routes.patch(
    "/time/:entryId",
    declareOp("update-time", "Fix a time entry", "Minutes, day or note of an entry. Its author, or a person with write rights in the project (an agent only its own; anyone else 403; non-member 404).", { params: EntryParam, body: patchSchema }, { schema: Row }),
    async (c, input) => {
      const { entry } = await entryToChange(c, input.params.entryId);
      const body: z.infer<typeof patchSchema> = input.body;
      if (!Object.values(body).some((v) => v !== undefined)) {
        throw AppError.validation("Nothing to change: give minutes, spentOn or note");
      }
      const [row] = await db.instance.update(agileTimeEntries).set(body).where(eq(agileTimeEntries.id, entry.id)).returning();
      return c.json(row);
    }
  );

  routes.delete(
    "/time/:entryId",
    declareOp("delete-time", "Remove a time entry", "Its author, or a person with write rights in the project (an agent only its own; anyone else 403; non-member 404).", { params: EntryParam }, { schema: Success }),
    async (c, input) => {
      const { entry } = await entryToChange(c, input.params.entryId);
      await db.instance.delete(agileTimeEntries).where(eq(agileTimeEntries.id, entry.id));
      return c.json({ success: true });
    }
  );

  const Cost = z
    .object({
      key: z.string(),
      people: z.object({ minutes: z.number(), hours: z.number(), costUsd: z.number().nullable() }).passthrough(),
      agents: z.object({ runs: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }).passthrough(),
      totalCostUsd: z.number().nullable(),
    })
    .passthrough();

  routes.get(
    "/issues/:key/cost",
    declareOp("issue-cost", "What an issue cost", `People's logged time (and its cost at the project's \`config.hourlyRateUsd\`; null without a rate) plus what agents reported for the work queued on it (runs, tokens, USD). \`totalCostUsd\` is null when people logged time and the project has no rate. ${WHO_SEES}`, { params: KeyParam }, { schema: Cost }),
    async (c, input) => {
      const { issue, project } = await issueFor(c, input.params.key, "view");
      const people = await peopleTime(issue.id, project.config?.hourlyRateUsd);
      const agents = await agentCost(issue.id);
      const totalCostUsd = people.minutes > 0 && people.costUsd === null ? null : round((people.costUsd ?? 0) + agents.costUsd);
      return c.json({ key: issue.key, people, agents, totalCostUsd });
    }
  );

  routes.get(
    "/:projectId/time",
    declareOp("project-time", "Time logged in a project", `Entries between \`from\` and \`to\` (YYYY-MM-DD, inclusive; default the last 30 days), optionally of one \`userId\`, with each issue's key, and totals per person. ${WHO_SEES}`, { params: ProjectParam, query: query({ from: text("YYYY-MM-DD"), to: text("YYYY-MM-DD"), userId: text("Only this member") }) }, { schema: ListWithTotal.extend({ totalMinutes: z.number().int() }).passthrough() }),
    async (c, input) => {
      const { project } = await projectFor(c, input.params.projectId, "view");
      const valid = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
      const to = valid(c.req.query("to")) ?? today();
      const from = valid(c.req.query("from")) ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const userId = c.req.query("userId");
      const docs = await db.instance
        .select({
          id: agileTimeEntries.id,
          issueKey: agileIssues.key,
          issueName: agileIssues.name,
          userId: agileTimeEntries.userId,
          minutes: agileTimeEntries.minutes,
          spentOn: agileTimeEntries.spentOn,
          note: agileTimeEntries.note,
        })
        .from(agileTimeEntries)
        .innerJoin(agileIssues, eq(agileTimeEntries.issueId, agileIssues.id))
        .where(
          and(
            eq(agileTimeEntries.projectId, project.id),
            gte(agileTimeEntries.spentOn, from),
            lte(agileTimeEntries.spentOn, to),
            userId ? eq(agileTimeEntries.userId, userId) : undefined
          )
        )
        .orderBy(asc(agileTimeEntries.spentOn))
        .limit(5000);
      const byUser = new Map<string, number>();
      for (const d of docs) byUser.set(d.userId, (byUser.get(d.userId) ?? 0) + d.minutes);
      return c.json({
        docs,
        totalDocs: docs.length,
        totalMinutes: docs.reduce((n, d) => n + d.minutes, 0),
        byUser: [...byUser.entries()].map(([id, minutes]) => ({ userId: id, minutes })),
        from,
        to,
      });
    }
  );

  return routes.ops;
}
