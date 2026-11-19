/**
 * kon-dms — the lists that returned every row can be read a page at a time
 * ============================================================================
 *
 * `list-versions`, `list-read-acknowledgments` and `list-incoming-links` take an optional
 * `limit` (1-500) and `offset` and answer `hasMore`. Without `limit` they answer every row,
 * as before, with `hasMore: false`.
 *
 * `search-documents` is a relevance top-k with a fallback when nothing matches: it declares
 * `unpaginated` instead of taking an offset, and answers as it always did.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { dmsOperations } from "../../kons/kon-dms/dms.routes";
import { createKonDMS } from "../../kons/kon-dms/index";

import { testAuth, dropToAppRole, migratedBase, requestAs } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const ids = {} as Record<string, string>;
let ops: Array<{ id: string; unpaginated?: string; input?: { query?: { shape: object } } }>;
const json = async (r: Response): Promise<any> => r.json();

/** Creates a public document as admin and publishes its first version. */
async function published(title: string, content: string): Promise<{ id: string; code: string }> {
  const created = await request("admin", "POST", "/documents", {
    title,
    visibility: "public",
    content,
    changelog: "x",
  });
  expect(created.status).toBe(201);
  const doc = await json(created);
  const version = (await json(await request("admin", "GET", `/documents/${doc.id}/versions`)))
    .docs[0].id;
  await request("admin", "POST", `/versions/${version}/submit`);
  await request("admin", "POST", `/versions/${version}/review`, { decision: "approved" });
  expect((await request("admin", "POST", `/versions/${version}/publish`)).status).toBe(200);
  return { id: doc.id, code: doc.code };
}

beforeAll(async () => {
  client = await migratedBase("kon-dms", [
    "0000_base_schema.sql",
    "0001_workflow_notifications.sql",
    "0002_slug_history_and_fts.sql",
    "0003_comments.sql",
    "0004_diagrams.sql",
    "0005_user_ids_and_rls.sql",
    "0006_system_without_user.sql",
    "0007_effective_admin.sql",
    "0008_sizes_as_bigint.sql",
  ]);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  const app = createKonDMS(ctx);
  ops = dmsOperations(ctx) as never;
  request = requestAs(host.mount(app));

  const target = await published("Manual de destino", "el manual");
  ids.target = target.id;
  // A second version (draft) of the target.
  const v2 = await request("admin", "POST", `/documents/${target.id}/versions`, {
    changelog: "segunda",
    content: "el manual, revisado",
  });
  expect(v2.status).toBe(201);
  // Two documents that link to it.
  await published("Enlaza uno", `ver [[${target.code}]]`);
  await published("Enlaza dos", `ver también [[${target.code}]]`);
  // Two readers acknowledge it.
  for (const reader of ["a", "b"] as const) {
    const ack = await request(reader, "POST", `/documents/${target.id}/acknowledge`, {});
    expect(ack.status).toBeLessThan(300);
  }
});

afterAll(async () => {
  await client?.close();
});

describe("versions", () => {
  test("limit=1 gives the newest and says there are more", async () => {
    const page = await json(await request("admin", "GET", `/documents/${ids.target}/versions?limit=1`));
    expect(page.docs).toHaveLength(1);
    expect(page.docs[0].status).toBe("draft");
    expect(page.hasMore).toBe(true);
    const next = await json(
      await request("admin", "GET", `/documents/${ids.target}/versions?limit=1&offset=1`)
    );
    expect(next.docs).toHaveLength(1);
    expect(next.docs[0].id).not.toBe(page.docs[0].id);
    expect(next.hasMore).toBe(false);
  });

  test("without limit, every version as before, and hasMore false", async () => {
    const all = await json(await request("admin", "GET", `/documents/${ids.target}/versions`));
    expect(all.docs).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });

  test("a limit out of range is refused", async () => {
    const res = await request("admin", "GET", `/documents/${ids.target}/versions?limit=501`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("acknowledgments and incoming links", () => {
  test("acknowledgments page", async () => {
    const page = await json(
      await request("admin", "GET", `/documents/${ids.target}/acknowledgments?limit=1`)
    );
    expect(page.docs).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const all = await json(await request("admin", "GET", `/documents/${ids.target}/acknowledgments`));
    expect(all.docs).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });

  test("incoming links page, by title", async () => {
    const page = await json(await request("admin", "GET", `/documents/${ids.target}/backlinks?limit=1`));
    expect(page.docs.map((d: any) => d.title)).toEqual(["Enlaza dos"]);
    expect(page.hasMore).toBe(true);
    const all = await json(await request("admin", "GET", `/documents/${ids.target}/backlinks`));
    expect(all.docs.map((d: any) => d.title)).toEqual(["Enlaza dos", "Enlaza uno"]);
    expect(all.hasMore).toBe(false);
  });
});

describe("search", () => {
  test("search-documents is a top-k: it declares unpaginated and takes no offset", () => {
    const search = ops.find((op) => op.id === "search-documents")!;
    expect(search.unpaginated).toMatch(/best matches/);
    expect(Object.keys(search.input?.query?.shape ?? {})).not.toContain("offset");
  });

  test("it answers as before: the best matches, folders and the kind of search", async () => {
    const res = await request("admin", "GET", "/search?q=manual");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["categories", "documents", "searchType", "total"]);
    expect(body.documents.map((d: any) => d.title)).toContain("Manual de destino");
    expect(body.hasMore).toBeUndefined();
  });
});
