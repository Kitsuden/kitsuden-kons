/**
 * A draft tournament does not exist outside the organization, through NO route
 * ============================================================================
 *
 * An earlier audit: `GET /tournaments/:id` and `/public/tournament/:id`
 * applied the `view` policy (404 for a draft), but the secondary routes
 * did not: tournament matches, its bracket and standings, Swiss, phases and
 * their results, check-in, broadcasts, the imported prize and the
 * reports of a match showed the entire draft, and team registration
 * could put people into it. The ids leaked through the analytics views.
 *
 * A single middleware in front of the whole router (like `withValidatedIds`): it takes
 * the tournament out of the path —directly, or through the phase or the match— and
 * responds 404 if the asker cannot see it. The same 404 as an id that does not
 * exist: from outside, a draft is indistinguishable from something not created.
 */
import { can, type AuthzUser } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import type { EsportsDb } from "./esports.db";
import { matches, phases, tournaments } from "./esports.schema";
import { isUuid } from "./valid-ids";

/**
 * Paths whose first id is the tournament's. No anchor at the start: the path
 * arrives with the mount prefix (`/api/esports/…`). `tournament/` does not match
 * `tournaments/` (the main route, which already checks it itself).
 */
const OF_TOURNAMENT = [
  /\/(?:public\/|import\/public\/|import\/)?tournament\/([^/]+)(?:\/|$)/,
  /\/matches\/tournament\/([^/]+)(?:\/|$)/,
];
const OF_PHASE = /\/phase\/([^/]+)(?:\/|$)/;
const OF_MATCH = /\/match\/([^/]+)(?:\/|$)/;

export function withHiddenDrafts(app: Hono, ctx: KonContext): Hono {
  const db = ctx.db.instance as EsportsDb;

  async function tournamentOf(path: string): Promise<string | null> {
    for (const re of OF_TOURNAMENT) {
      const m = re.exec(path);
      if (m) return m[1]!;
    }
    const phase = OF_PHASE.exec(path);
    if (phase && isUuid(phase[1]!)) {
      const [f] = await db
        .select({ tournamentId: phases.tournamentId })
        .from(phases)
        .where(eq(phases.id, phase[1]!))
        .limit(1);
      return f?.tournamentId ?? null;
    }
    const match = OF_MATCH.exec(path);
    if (match && isUuid(match[1]!)) {
      const [p] = await db
        .select({ tournamentId: matches.tournamentId })
        .from(matches)
        .where(eq(matches.id, match[1]!))
        .limit(1);
      return p?.tournamentId ?? null;
    }
    return null;
  }

  const exterior = new Hono();
  exterior.use("*", async (c, next) => {
    const tournamentId = await tournamentOf(c.req.path);
    if (tournamentId && isUuid(tournamentId)) {
      const [t] = await db
        .select({ status: tournaments.status })
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);
      const user = ((c.get as (k: string) => unknown)("user") ?? null) as AuthzUser | null;
      if (t && !(await can(user, "view", { status: t.status }, "esports"))) {
        return c.json({ error: "Not found" }, 404);
      }
    }
    await next();
  });
  exterior.route("/", app);
  return exterior;
}
