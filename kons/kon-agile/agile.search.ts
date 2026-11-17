/**
 * kon-agile — full-text search across a project (1.4)
 * ============================================================================
 *
 * `search` in the issue list and saved views now matches the words of the key, title, description and
 * comments (agile.query.ts, migration 0006). This route answers the search box: the best matches first,
 * and where each one matched, with the matching words marked, so an agent reads a short line instead
 * of the whole issue.
 */

import { AppError, type AnyOperation } from "@kitsuden/engine";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import type { AgileAccess } from "./agile.access";
import type { AgileDb } from "./agile.db";
import { searchCondition, searchQuery } from "./agile.query";
import { agileIssues, agileStates } from "./agile.schema";
import { declareOp, ProjectParam, query, registry, text } from "./operations";

const Hit = z
  .object({
    key: z.string(),
    name: z.string(),
    rank: z.number(),
    matchedIn: z.enum(["title", "description", "comment"]),
    snippet: z.string().nullable(),
  })
  .passthrough();

export function searchOperations(db: { instance: AgileDb }, access: AgileAccess): AnyOperation[] {
  const routes = registry();

  routes.get(
    "/:projectId/search",
    declareOp(
      "search-issues",
      "Search a project's issues",
      'Full-text search over the key, title, description and comments of the project\'s issues. `q` takes words, `"an exact phrase"`, `-without` and `or`; a half-typed key or title word also matches. Best matches first (title over description over comments), each with where it matched and a short snippet with the words between « ». `includeArchived=true` also searches archived issues; `limit` 1-50 (default 20). Only for members of the project (and admin); anyone else gets 404.',
      {
        params: ProjectParam,
        query: query({ q: text("What to look for (2-200 characters)"), includeArchived: text("`true`: archived issues too"), limit: text("1-50 (default 20)") }),
      },
      { schema: z.object({ docs: z.array(Hit), totalDocs: z.number().int() }).passthrough() }
    ),
    async (c, input) => {
      const { project } = await access.projectFor(c, input.params.projectId, "view");
      const q = (c.req.query("q") ?? "").trim();
      if (q.length < 2 || q.length > 200) throw AppError.validation("q must be 2 to 200 characters", { field: "q" });
      const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 50);
      const tsq = searchQuery(q);
      const commentHit = sql`(select k.content_text from agile_comments k where k.issue_id = ${agileIssues.id} and k.search_vector @@ ${tsq} order by ts_rank(k.search_vector, ${tsq}) desc limit 1)`;
      const options = "StartSel=«, StopSel=», MaxWords=18, MinWords=6, ShortWord=2";

      const rows = await db.instance
        .select({
          key: agileIssues.key,
          name: agileIssues.name,
          assigneeId: agileIssues.assigneeId,
          priority: agileIssues.priority,
          stateGroup: agileStates.group,
          archivedAt: agileIssues.archivedAt,
          rank: sql<number>`ts_rank("agile_issues"."search_vector", ${tsq})`,
          inTitle: sql<boolean>`to_tsvector('simple', coalesce(${agileIssues.key}, '') || ' ' || coalesce(${agileIssues.name}, '')) @@ ${tsq} OR ${agileIssues.name} ILIKE ${`%${q}%`} OR ${agileIssues.key} ILIKE ${`%${q}%`}`,
          inDescription: sql<boolean>`to_tsvector('simple', coalesce(${agileIssues.descriptionText}, '')) @@ ${tsq}`,
          descriptionSnippet: sql<string | null>`ts_headline('simple', coalesce(${agileIssues.descriptionText}, ''), ${tsq}, ${options})`,
          comment: commentHit,
        })
        .from(agileIssues)
        .leftJoin(agileStates, eq(agileIssues.stateId, agileStates.id))
        .where(
          and(
            eq(agileIssues.projectId, project.id),
            c.req.query("includeArchived") === "true" ? undefined : isNull(agileIssues.archivedAt),
            searchCondition(q)
          )
        )
        .orderBy(desc(sql`ts_rank("agile_issues"."search_vector", ${tsq})`), desc(agileIssues.updatedAt))
        .limit(limit * 2);

      const docs = rows
        .map((r) => {
          const matchedIn = r.inTitle ? ("title" as const) : r.inDescription ? ("description" as const) : ("comment" as const);
          // Title over description over comments, then Postgres' own rank.
          const weight = matchedIn === "title" ? 3 : matchedIn === "description" ? 2 : 1;
          const snippet =
            matchedIn === "description"
              ? r.descriptionSnippet
              : matchedIn === "comment" && r.comment
                ? String(r.comment).slice(0, 200)
                : null;
          return {
            key: r.key,
            name: r.name,
            assigneeId: r.assigneeId,
            priority: r.priority,
            stateGroup: r.stateGroup,
            archived: r.archivedAt !== null,
            rank: Math.round((weight + Number(r.rank ?? 0)) * 1000) / 1000,
            matchedIn,
            snippet,
          };
        })
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit);
      return c.json({ docs, totalDocs: docs.length });
    }
  );

  return routes.ops;
}
