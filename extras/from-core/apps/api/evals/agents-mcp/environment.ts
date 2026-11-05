/**
 * Test environment: an in-memory Kitsuden, freshly made
 * ============================================================================
 *
 * Each (case, repetition) starts with its own PGlite, the REAL migrations
 * of the kons and the routers mounted as in the API. Nothing is shared between
 * tests: what an agent leaves half done in one case gives the next one no clues —nor
 * takes any away.
 *
 * The tools reach the API through `api`, which mimics the MCP server's
 * `apiRequest`: path relative to `/api`, and the error with its status and body
 * as is, which is what the agent reads.
 *
 * ── HOW IT DIFFERS FROM PRODUCTION ─────────────────────────────────────────
 *
 *   · There is no core database: `/data-sets` and `/docs/openapi.json` do not exist,
 *     so `catalog_create`, `catalog_add_entries` and `kitsuden_describe_api`
 *     are left out of the agent's tools.
 *   · Nor are the 27 generic tools of the server there: what is measured
 *     is whether the domain ones suffice, not whether the agent prefers them.
 *   · The session always belongs to the organization. Permissions have their own tests.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono, type MiddlewareHandler } from "hono";

import {
  createMemoryStateStore,
  respondError,
  setStateStore,
  setStateTransport,
} from "@kitsuden/engine";

import { registerBroadcastPolicy } from "../../../../packages/kons/kon-broadcast/broadcast.policy";
import { createKonBroadcast } from "../../../../packages/kons/kon-broadcast/index";
import { registerEsportsPolicy } from "../../../../packages/kons/kon-esports/esports.policy";
import { createKonEsports } from "../../../../packages/kons/kon-esports/index";
import { createKonTierlist } from "../../../../packages/kons/kon-tierlist/index";
import { registerTierlistPolicy } from "../../../../packages/kons/kon-tierlist/tierlist.policy";
import {
  DOMAIN_TOOL_DEFINITIONS,
  runDomainTool,
  type ApiCall,
} from "../../../../packages/mcp-server/src/domain-tools";
import { generateAgentGuide } from "../../src/lib/agent-guide";
import { registerKonRouter, konRoutes } from "../../src/lib/kon-routes";
import { createTestKonContext } from "../../src/lib/test-kon-context";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const KONS = ["kon-esports", "kon-tierlist", "kon-broadcast"];

/** The ones that need the core database, which this environment does not have. */
const OUTSIDE_ENVIRONMENT = new Set([
  "catalog_create",
  "catalog_add_entries",
  "kitsuden_describe_api",
]);

export const AGENT_TOOLS = DOMAIN_TOOL_DEFINITIONS.filter(
  (d) => !OUTSIDE_ENVIRONMENT.has(d.name)
);

let migrations: string[] | null = null;

function migrationsSql(): string[] {
  migrations ??= KONS.flatMap((kon) => {
    const dir = join(ROOT, "packages/kons", kon, "migrations");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8"));
  });
  return migrations;
}

const asOrganization: MiddlewareHandler = async (c, next) => {
  c.set("user" as never, { id: "to-eval", role: "admin", email: "to@eval.local" } as never);
  await next();
};

let preparedOnce = false;

export interface Environment {
  /** What the tools use: this Kitsuden's API. */
  api: ApiCall;
  /** Direct database query. Only for setup and grading: the agent does not have it. */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** A domain tool; throws if it returns an error. For setup and for the oracle. */
  tool(name: string, args: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export async function createEnvironment(): Promise<Environment> {
  const client = new PGlite();
  for (const sql of migrationsSql()) await client.exec(sql);

  if (!preparedOnce) {
    // Broadcast publishes the overlay state: there are no sockets here.
    setStateTransport({ broadcast() {} });
    setStateStore(createMemoryStateStore());
  }
  // Policies live in a process-wide registry; registering them again changes nothing.
  registerEsportsPolicy();
  registerTierlistPolicy();
  registerBroadcastPolicy();

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as never,
    auth: {
      requireAuth: asOrganization,
      optionalAuth: asOrganization,
      requireRole: () => asOrganization,
    } as never,
  });
  const esports = createKonEsports(ctx);
  const tierlist = createKonTierlist(ctx);
  const broadcast = createKonBroadcast(ctx);

  if (!preparedOnce) {
    // For the guide. The shape of the routes is the same in all tests.
    registerKonRouter("kon-esports", "/api/esports", esports);
    registerKonRouter("kon-tierlist", "/api/tierlist", tierlist);
    registerKonRouter("kon-broadcast", "/api/broadcast", broadcast);
    preparedOnce = true;
  }

  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", asOrganization);
  // Same as in apps/api/src/index.ts.
  app.get("/llms.txt", (c) =>
    c.text(
      generateAgentGuide({ baseUrl: "http://localhost:3000/api", routes: konRoutes() }),
      200,
      { "content-type": "text/markdown; charset=utf-8" }
    )
  );
  app.route("/esports", esports);
  app.route("/tierlist", tierlist);
  app.route("/broadcast", broadcast);

  const api: ApiCall = async (path, method = "GET", body) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`API ${method} ${path} failed (${res.status}): ${await res.text()}`);
    }
    if (res.status === 204) return null;
    return (res.headers.get("content-type") ?? "").includes("json") ? res.json() : res.text();
  };

  return {
    api,
    async sql<T>(query: string, params: unknown[] = []) {
      return (await client.query<T>(query, params)).rows;
    },
    async tool(name, args) {
      const r = await runDomainTool(name, args, api);
      if (!r) throw new Error(`«${name}» is not a domain tool`);
      const text = r.content[0].text;
      if (r.isError) throw new Error(`${name}: ${text}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => client.close(),
  };
}
