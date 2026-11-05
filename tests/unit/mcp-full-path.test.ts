/**
 * An agent builds with the domain MCP tools, end to end
 * ============================================================================
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * `mcp-herramientas-de-dominio.test.ts` uses a fake API: it checks that each
 * tool calls the route it believes in. This one runs the REAL kons
 * —esports, tier list and broadcast on PGlite, with their migrations— and walks through
 * the guide's recipes the way an agent would:
 *
 *   · Tier list: create with a catalog, place, resync without losing what
 *     was placed.
 *   · Swiss: create, register, check-in, generate, report two rounds and view the
 *     standings.
 *
 * If a route changes shape —a field gets renamed, a response gets
 * wrapped in `data`— the tool breaks silently for the agent. Here
 * the test breaks.
 *
 * And the traps an agent really steps on, with the error it should see:
 * reporting with the player id, pairing with the round half done, a Bo2.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createMemoryStateStore,
  resetSyncedState,
  respondError,
  setStateStore,
  setStateTransport,
} from "@kitsuden/engine";

import {
  generateAgentGuide,
} from "../../.kitsuden/apps/api/src/lib/agent-guide";
import {
  forgetKonRouters,
  registerKonRouter,
  konRoutes,
} from "../../.kitsuden/apps/api/src/lib/kon-routes";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { registerBroadcastPolicy } from "../../kons/kon-broadcast/broadcast.policy";
import { createKonBroadcast } from "../../kons/kon-broadcast/index";
import { registerEsportsPolicy } from "../../kons/kon-esports/esports.policy";
import { createKonEsports } from "../../kons/kon-esports/index";
import { createKonTierlist } from "../../kons/kon-tierlist/index";
import { registerTierlistPolicy } from "../../kons/kon-tierlist/tierlist.policy";
import {
  runDomainTool,
  type ApiCall,
} from "../../extras/from-core/packages/mcp-server/src/domain-tools";

const ROOT = resolve(__dirname, "../..");
const KONS = ["kon-esports", "kon-tierlist", "kon-broadcast"];

let client: PGlite;
let app: Hono;
let ctx: ReturnType<typeof createTestKonContext>;

const asOrganization: MiddlewareHandler = async (c, next) => {
  c.set("user" as never, { id: "to-1", role: "admin", email: "to@example.com" } as never);
  await next();
};

/**
 * The same boundary as `apiRequest` in the MCP server: path relative to
 * `/api`, error with the status and the body as is, text if it is not JSON.
 */
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

async function tool(name: string, args: Record<string, unknown>) {
  const r = await runDomainTool(name, args, api);
  if (!r) throw new Error(`${name} is not a domain tool`);
  const text = r.content[0].text;
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: Boolean(r.isError), text, json };
}

/** A tool that fails here is a test failure, with the message the agent would see. */
async function ok(name: string, args: Record<string, unknown>) {
  const r = await tool(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.json;
}

beforeAll(async () => {
  client = new PGlite();
  for (const kon of KONS) {
    const dir = join(ROOT, "kons", kon, "migrations");
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await client.exec(readFileSync(join(dir, file), "utf8"));
    }
  }

  setStateTransport({ broadcast() {} });
  setStateStore(createMemoryStateStore());

  ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: {
      requireAuth: asOrganization,
      optionalAuth: asOrganization,
      requireRole: () => asOrganization,
    } as any,
  });

  app = new Hono();
  app.onError((err, c) => respondError(c, err));
  // The tier list mounts no auth of its own: it reads the user the host leaves.
  app.use("*", asOrganization);
  app.route("/esports", createKonEsports(ctx));
  app.route("/tierlist", createKonTierlist(ctx));
  app.route("/broadcast", createKonBroadcast(ctx));
});

beforeEach(() => {
  // Other tests call `resetAuthz()`: without this, depending on order, everything is 403.
  registerEsportsPolicy();
  registerTierlistPolicy();
  registerBroadcastPolicy();
});

afterAll(async () => {
  await client?.close();
  resetSyncedState();
  forgetKonRouters();
});

describe("recipe: character tier list", () => {
  const catalog = [
    { id: "aria", label: "Aria", imageUrl: "https://example.com/aria.png" },
    { id: "boro", label: "Boro" },
  ];

  it("creating with a catalog leaves everything unranked, with the default rows", async () => {
    const list = await ok("tierlist_create", { title: "Personajes MCP", catalog: catalog });

    expect(list.slug).toBe("personajes-mcp");
    expect(list.tiers.map((t: any) => t.id)).toEqual(["s", "a", "b", "c", "d"]);
    expect(list.unranked.map((i: any) => i.id)).toEqual(["aria", "boro"]);

    const { tierLists } = await ok("tierlist_list", { search: "personajes" });
    expect(tierLists, "the slug is reached through the title").toEqual([
      { slug: "personajes-mcp", title: "Personajes MCP" },
    ]);
  });

  it("placing moves the item to its row", async () => {
    const list = await ok("tierlist_place", {
      slug: "personajes-mcp",
      itemId: "aria",
      tierId: "s",
    });

    // The image travels with the item: resyncing with what was read does not lose it.
    expect(list.tiers[0].items).toEqual([
      { id: "aria", label: "Aria", imageUrl: "https://example.com/aria.png" },
    ]);
    expect(list.unranked.map((i: any) => i.id)).toEqual(["boro"]);
  });

  it("resyncing brings in what is new without moving what was placed", async () => {
    const list = await ok("tierlist_sync", {
      slug: "personajes-mcp",
      catalog: [...catalog, { id: "ciro", label: "Ciro" }],
    });

    expect(list.tiers[0].items.map((i: any) => i.id)).toEqual(["aria"]);
    expect(list.unranked.map((i: any) => i.id)).toEqual(["boro", "ciro"]);
  });

  it("a row that does not exist is an error, not a lost move", async () => {
    const r = await tool("tierlist_place", {
      slug: "personajes-mcp",
      itemId: "boro",
      tierId: "z",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("(409)");
  });
});

describe("recipe: Swiss tournament with check-in", () => {
  let tournamentId = "";
  let registered: { alias: string; playerId: string; participantId: string }[] = [];

  /** Reports all open sets giving the win to the first side. */
  async function reportOpenRound(): Promise<number> {
    const { openSets } = await ok("tournament_sets", { tournamentId: tournamentId });
    for (const set of openSets) {
      await ok("tournament_report_set", {
        tournamentId: tournamentId,
        matchId: set.matchId,
        winnerId: set.sides[0].participantId,
      });
    }
    return openSets.length;
  }

  it("creating and registering returns the ids needed afterwards", async () => {
    const t = await ok("tournament_create", {
      title: "Suizo MCP",
      bracketFormat: "swiss",
      swissRounds: 2,
    });
    expect(t.status, "it is born Open so that registration is possible").toBe("Open");
    tournamentId = t.tournamentId;

    const r = await ok("tournament_add_players", {
      tournamentId: tournamentId,
      aliases: ["Aria", "Boro", "Ciro", "Dara"],
    });
    registered = r.registered;

    expect(registered).toHaveLength(4);
    for (const i of registered) expect(i.participantId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("through the title you reach the tournament, and from there each participantId", async () => {
    const { tournaments } = await ok("tournament_list", { search: "Suizo MCP" });
    expect(tournaments.map((t: any) => t.tournamentId)).toEqual([tournamentId]);

    const t = await ok("tournament_get", { tournamentId: tournamentId });
    expect(t.bracketFormat).toBe("swiss");
    expect(t.participants.map((p: any) => [p.name, p.participantId, p.checkedIn]).sort()).toEqual(
      registered.map((i) => [i.alias, i.participantId, false]).sort()
    );
  });

  it("check-in: open the window and confirm everyone", async () => {
    await ok("tournament_checkin", { tournamentId: tournamentId, action: "open", minutes: 15 });
    for (const i of registered) {
      await ok("tournament_checkin", {
        tournamentId: tournamentId,
        action: "mark",
        participantId: i.participantId,
      });
    }

    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM esports_tournament_participants
        WHERE tournament_id = $1 AND checked_in_at IS NOT NULL`,
      [tournamentId]
    );
    expect(r.rows[0].n).toBe(4);
  });

  it("starting pairs round 1, with names", async () => {
    const r = await ok("tournament_start", { tournamentId: tournamentId });

    expect(r.bracketFormat).toBe("swiss");
    expect(r.openSets).toHaveLength(2);
    const names = r.openSets.flatMap((s: any) => s.sides.map((l: any) => l.name)).sort();
    expect(names).toEqual(["Aria", "Boro", "Ciro", "Dara"]);
  });

  it("reporting with the PLAYER id is an error that shows the participants", async () => {
    const { openSets } = await ok("tournament_sets", { tournamentId: tournamentId });
    const [set] = openSets;
    const player = registered.find((i) => i.participantId === set.sides[0].participantId)!;

    const r = await tool("tournament_report_set", {
      tournamentId: tournamentId,
      matchId: set.matchId,
      winnerId: player.playerId,
    });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("(400)");
    expect(r.text, "the error has to give the right id").toContain(set.sides[0].participantId);
  });

  it("with the round half done the next one is not paired", async () => {
    const r = await tool("tournament_next_round", { tournamentId: tournamentId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("(409)");
  });

  it("two reported rounds close the Swiss with the standings", async () => {
    expect(await reportOpenRound()).toBe(2);

    const round2 = await ok("tournament_next_round", { tournamentId: tournamentId });
    expect(round2.openSets).toHaveLength(2);
    expect(await reportOpenRound()).toBe(2);

    const table = await ok("tournament_standings", { tournamentId: tournamentId });
    expect(table.complete).toBe(true);
    expect(table.round).toBe(2);
    expect(table.standings).toHaveLength(4);
    expect(table.standings[0].place).toBe(1);
    expect(table.standings.map((s: any) => s.name).sort()).toEqual([
      "Aria",
      "Boro",
      "Ciro",
      "Dara",
    ]);
  });

  it("with includeCompleted the resolved sets come out, which is what is needed to correct", async () => {
    const r = await ok("tournament_sets", { tournamentId: tournamentId, includeCompleted: true });

    expect(r.openSets).toEqual([]);
    expect(r.completedSets).toHaveLength(4);
    // `reportOpenRound` gives the win to the first side.
    for (const s of r.completedSets) expect(s.winner.participantId).toBe(s.sides[0].participantId);
  });

  it("with the Swiss finished, pairing another round is an error", async () => {
    const r = await tool("tournament_next_round", { tournamentId: tournamentId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("(409)");
  });
});

describe("broadcast from the tools", () => {
  it("the sections say what is turned off", async () => {
    const r = await ok("broadcast_sections", {});
    expect(Array.isArray(r.data)).toBe(true);
    expect(r.data.some((s: any) => s.enabled === false)).toBe(true);
  });

  it("a Bo3 is created with bestOf and the server computes how many wins are needed", async () => {
    const r = await ok("broadcast_create_match", {
      eventTitle: "Final MCP",
      bestOf: 3,
      sideA: { name: "Aria" },
    });
    expect(r.data.firstTo).toBe(2);
    expect(r.data.profileId).toBe("1v1");
  });

  it("a Bo2 does not exist and the error explains it", async () => {
    const r = await tool("broadcast_create_match", { bestOf: 2 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("bestOf must be 1, 3, 5, 7 or 9");
  });
});

describe("the guide served at /llms.txt", () => {
  it("names the tools and lists the kons' real routes", () => {
    forgetKonRouters();
    registerKonRouter("kon-esports", "/api/esports", createKonEsports(ctx));

    const guide = generateAgentGuide({
      baseUrl: "http://localhost:3000/api",
      routes: konRoutes(),
    });

    expect(guide).toMatch(/matches\/tournament\/[:{]tournamentId}?\/report/);
    expect(guide).toContain("winnerId");
    expect(guide, "Brain's old output is not the guide").not.toContain(
      "Total documented entities"
    );
  });

  it("without routes, it says where they come from instead of inventing them", () => {
    const guide = generateAgentGuide({ baseUrl: "http://localhost:3000/api" });
    expect(guide).toContain("GET /llms.txt");
  });
});
