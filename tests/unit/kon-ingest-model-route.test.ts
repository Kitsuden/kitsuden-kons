/**
 * kon-ingest: the kebab-case `/<plural>/model` routes and the deprecated `/_model`
 * ============================================================================
 *
 * The core generates `describe-<model>` at `/<plural>/_model`, which breaks the
 * API's path style. The kon adds `describe-<model>-model` at `/<plural>/model`
 * with the same answer and marks the old operation deprecated. Both must work
 * until the sunset; the old one says so in its headers; and the models must
 * still be found by the core (`GET /api/models` reads them from the identity
 * of the `describe-*` operations). The semantic search is a top-k and says so
 * (`unpaginated`) instead of taking an offset.
 */

import type { PGlite } from "@electric-sql/pglite";
import { PGlite as PGliteClass } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { operationModel } from "../../.kitsuden/packages/engine/src/models";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { kon } from "../../kons/kon-ingest";

import { AGENT_FUNCTIONS, APP_ROLE, dropToAppRole, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;

beforeAll(async () => {
  client = new PGliteClass();
  await client.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
  const dir = resolve(__dirname, "../../kons/kon-ingest/migrations");
  // PGlite has no pgvector: the `vector` statements are left out, as in kon-ingest.test.ts.
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(dir, file), "utf8")
      .split("\n")
      .filter((line) => !/vector/.test(line))
      .join("\n");
    await client.exec(sql);
  }
  await client.exec(`
    CREATE ROLE ${APP_ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never } as never);
  request = requestAs(host.mount(kon.createRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

describe("describe routes", () => {
  for (const plural of ["documents", "chunks"]) {
    it(`/${plural}/model answers the model, and /${plural}/_model the same, deprecated`, async () => {
      const fresh = await request("a", "GET", `/${plural}/model`);
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("deprecation")).toBeNull();
      const body = await fresh.json();

      const old = await request("a", "GET", `/${plural}/_model`);
      expect(old.status).toBe(200);
      expect(await old.json()).toEqual(body);
      expect(old.headers.get("deprecation")).toMatch(/^@\d+$/);
      expect(new Date(old.headers.get("sunset")!).toISOString().slice(0, 10)).toBe("2027-05-18");
    });
  }

  it("`model` is not taken for a row id, and both need a session", async () => {
    expect((await request("anon", "GET", "/documents/model")).status).toBe(401);
    expect((await request("anon", "GET", "/documents/_model")).status).toBe(401);
  });

  it("the old operations name their replacement, and the core still finds both models", () => {
    const ops = (kon as unknown as { operations: Array<{ id: string; route: string; deprecated?: unknown }> })
      .operations;
    const byId = new Map(ops.map((op) => [op.id, op]));
    expect(byId.get("describe-document")?.deprecated).toEqual({
      since: "2026-11-18",
      sunset: "2027-05-18",
      use: "describe-document-model",
    });
    expect(byId.get("describe-chunk")?.deprecated).toMatchObject({ use: "describe-chunk-model" });
    expect(byId.get("describe-document-model")?.route).toBe("/documents/model");
    expect(byId.get("describe-chunk-model")?.route).toBe("/chunks/model");
    expect(byId.get("describe-document-model")?.deprecated).toBeUndefined();

    // `GET /api/models` finds a model by the identity of its `describe-*` operation:
    // the deprecated one must still be the core's own object, not a copy.
    expect(operationModel(byId.get("describe-document")!)?.model.name).toBe("document");
    expect(operationModel(byId.get("describe-chunk")!)?.model.name).toBe("chunk");
    expect(operationModel({ ...byId.get("describe-document")! })).toBeNull();
  });
});

describe("semantic search", () => {
  it("search-chunks is a top-k: it takes no offset and declares unpaginated, and stays the core's object", () => {
    const ops = (
      kon as unknown as {
        operations: Array<{ id: string; route: string; unpaginated?: string; input?: { query?: { shape: object } } }>;
      }
    ).operations;
    const search = ops.find((op) => op.id === "search-chunks")!;
    expect(search.route).toBe("/chunks/search");
    expect(search.unpaginated).toMatch(/best N matches/);
    expect(Object.keys(search.input?.query?.shape ?? {}).sort()).toEqual(["limit", "q"]);
    expect(operationModel(search as never)?.model.name).toBe("chunk");
    // Only the searches: the other lists keep paging.
    expect(ops.filter((op) => op.unpaginated).map((op) => op.id)).toEqual(["search-chunks"]);
  });
});
