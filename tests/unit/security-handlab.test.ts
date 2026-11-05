/**
 * The hand generator (kon-cardsim `/hands`) — datasets are editorial; decks belong to their owner
 * ============================================================================
 *
 * Audit 2026-10-15. Dataset `create` was "having an account", and sign-up is
 * public: anyone published catalogs of up to 30,000 cards, with arbitrary names
 * and `imageUrl` (including `javascript:`), served to everyone.
 * Dealing/simulating is public and expensive and had no brake.
 *
 * Against PGlite with the kon's real migrations and two users.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createKonCardsim, kon } from "../../kons/kon-cardsim";
import { registerHandlabPolicy } from "../../kons/kon-cardsim/handlab.policy";

const here = dirname(fileURLToPath(import.meta.url));

let client: PGlite;
let app: Hono;
let session: { id: string; role: string } | null = null;

const EDITOR = { id: "u-editora", role: "editor" };
const ANA = { id: "u-ana", role: "user" };
const BEA = { id: "u-bea", role: "user" };

beforeAll(async () => {
  client = await PGlite.create();
  const dir = resolve(here, "../../kons/kon-cardsim/migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(dir, f), "utf8"));
  }
  registerHandlabPolicy();
  const withSession =
    (mandatory: boolean) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
    (c: any, next: any) => {
      if (session) c.set("user", session);
      else if (mandatory) return c.json({ error: "no session" }, 401);
      return next();
    };
  const ctx = createTestKonContext({
    db: {
      instance: drizzle(client),
      execute: async () => undefined,
      tableExists: async () => true,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    auth: { requireAuth: withSession(true), optionalAuth: withSession(false) } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);
  app = new Hono();
  app.onError((err) => {
    if (err instanceof AppError) {
      return Response.json({ error: err.message, details: err.details }, { status: err.status });
    }
    return Response.json({ error: String(err) }, { status: 500 });
  });
  app.route("/", createKonCardsim(ctx));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  session = null;
  await client.exec(`
    DELETE FROM handlab_cards; DELETE FROM handlab_decks; DELETE FROM handlab_datasets;
    INSERT INTO handlab_datasets (id, slug, name, hand_size, deck_min, deck_max, max_copies, owner_id)
      VALUES ('ds1', 'demo', 'Demo', 2, 1, 60, 4, 'u-editora');
    INSERT INTO handlab_cards (id, dataset_id, card_id, name) VALUES
      ('k1', 'ds1', 'a', 'Carta A'), ('k2', 'ds1', 'b', 'Carta B');
    INSERT INTO handlab_decks (id, dataset_id, name, cards, owner_id, share_id)
      VALUES ('deck-ana', 'ds1', 'Secreto', '["a","b","a"]', 'u-ana', 's1');
  `);
});

const post = (route: string, body: unknown) =>
  app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const dataset = {
  slug: "nuevo",
  name: "Nuevo",
  cards: [{ cardId: "x", name: "X" }],
};

describe("datasets: published by the team", () => {
  it("a regular account neither creates nor imports datasets", async () => {
    session = ANA;
    expect((await post("/hands/datasets/import", dataset)).status).toBe(403);
    expect((await post("/hands/datasets", { slug: "otro", name: "Other" })).status).toBe(403);
    const n = await client.query("SELECT 1 FROM handlab_datasets");
    expect(n.rows).toHaveLength(1);
  });

  it("nor uploads cards nor deletes an existing one", async () => {
    session = ANA;
    expect(
      (await post("/hands/datasets/demo/cards", { cards: [{ cardId: "z", name: "Z" }] })).status
    ).toBe(403);
    expect((await app.request("/hands/datasets/demo", { method: "DELETE" })).status).toBe(403);
  });

  it("the team does", async () => {
    session = EDITOR;
    expect((await post("/hands/datasets/import", dataset)).status).toBe(201);
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>", "//evil.example/x.png"])(
    "rejects imageUrl %s",
    async (url) => {
      session = EDITOR;
      const r = await post("/hands/datasets/import", {
        ...dataset,
        cards: [{ cardId: "x", name: "X", imageUrl: url }],
      });
      expect(r.status).toBe(422);
    }
  );

  it("the public listing does not expose the owner account's id", async () => {
    const { data } = await (await app.request("/hands/datasets")).json();
    expect(data[0]).not.toHaveProperty("ownerId");
  });
});

describe("decks: their owner's", () => {
  it("Bea does not deal, validate or simulate with Ana's deck (404)", async () => {
    session = BEA;
    expect((await post("/hands/hands", { deckId: "deck-ana" })).status).toBe(404);
    expect((await post("/hands/validate", { deckId: "deck-ana" })).status).toBe(404);
    session = null;
    expect((await post("/hands/hands", { deckId: "deck-ana" })).status).toBe(404);
  });

  it("Ana does", async () => {
    session = ANA;
    expect((await post("/hands/hands", { deckId: "deck-ana", count: 1 })).status).toBe(200);
  });

  it("GET /decks returns only your own", async () => {
    session = BEA;
    expect((await (await app.request("/hands/decks")).json()).data).toEqual([]);
  });
});

describe("the expensive has a brake", () => {
  it("goldfish, hands and random-deck declare a request limit", () => {
    const routes = (kon.rateLimits ?? []).map((r) => r.path);
    expect(routes).toEqual(
      expect.arrayContaining(["/hands/goldfish", "/hands/hands", "/hands/datasets/:slug/random-deck"])
    );
  });
});
