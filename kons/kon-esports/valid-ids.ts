/**
 * An id that is not a uuid does not exist: 404, not a Postgres 500
 * ============================================================================
 *
 * Phase D (e2e against the real API):
 *
 *     GET /api/esports/tournaments/no-uuid          → 500
 *     GET /api/esports/public/tournament/no-uuid    → 500
 *     GET /api/esports/public/teams/no-uuid/roster  → 500
 *
 * All the kon's tables have `id uuid`, and the path value went as is into the
 * `WHERE`: Postgres answered `invalid input syntax for type uuid` (22P02).
 * Catching that error in the route is no good: the request runs in the host's
 * RLS transaction and a SQL error leaves it aborted. You must not get as far
 * as asking.
 *
 * Instead of repeating the check in ~50 routes, the router is wrapped: for
 * each pattern carrying an id parameter a middleware is registered that looks at
 * the value before the handler runs. A new route with `:id` is covered
 * automatically.
 */
import { Hono } from "hono";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parameters that in this kon are ALWAYS a uuid (`:token` and `:slug` are not). */
const UUID_PARAMS = ["id", "tournamentId", "matchId", "participantId", "phaseId"];
const WITH_ID = new RegExp(`/:(${UUID_PARAMS.join("|")})(?=/|$)`);

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Converts a Hono pattern into an expression that matches the END of the path. */
function toExpression(pattern: string): RegExp {
  const body = pattern
    .split("/")
    .map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`${body}/?$`);
}

export function withValidatedIds<T extends Hono<any>>(app: T): Hono {
  const patterns = [...new Set(app.routes.map((r) => r.path))];
  // A path that matches a route WITHOUT that parameter (e.g. a literal in the
  // same position) is left alone: that other route is the one in charge.
  const literals = patterns.filter((p) => !WITH_ID.test(p)).map(toExpression);

  // ONE middleware (`*`), not one per pattern: each Hono `use(pattern)` is
  // one more `ALL` route that the host's authorization matrix would have to
  // classify one by one (46 in this kon). Ids are extracted with the expression of
  // each pattern.
  const withId = patterns.filter((p) => WITH_ID.test(p)).map(toExpressionWithIds);
  const exterior = new Hono();
  exterior.use("*", async (c, next) => {
    const path = c.req.path;
    const bad = withId.some((re) => {
      const m = re.exec(path);
      return !!m?.groups && Object.values(m.groups).some((v) => !isUuid(v));
    });
    if (bad && !literals.some((re) => re.test(path))) {
      return c.json({ error: "Not found" }, 404);
    }
    await next();
  });
  exterior.route("/", app);
  return exterior;
}

/** Like `toExpression`, but captures (by name) the parameters that are uuids. */
function toExpressionWithIds(pattern: string): RegExp {
  const body = pattern
    .split("/")
    .map((s) => {
      if (!s.startsWith(":")) return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const name = s.slice(1);
      return UUID_PARAMS.includes(name) ? `(?<${name}>[^/]+)` : "[^/]+";
    })
    .join("/");
  return new RegExp(`${body}/?$`);
}
