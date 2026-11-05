/**
 * kon-dms — permissions by document, folder and group
 * ============================================================================
 *
 * REAL kon routes against PGlite with forced RLS, a non-superuser role and
 * better-auth user ids (text, not uuid: with the earlier `uuid` columns you
 * could not even create a document with a real account).
 *
 * Layout:
 *   R  — restricted, owner `staff`, shared with `member`.
 *        v1 published (with file f1), v2 draft (with file f2).
 *   W  — approval flow: owner `staff`, reviewers `revisor` (editor) and
 *        `b` (normal account: since the audit of 2026-10-25 reviewing belongs to the
 *        team, admin or editor, and never to the document's owner).
 *   PUB — `public` published, by `admin`: any account sees it.
 *   DIR — by `admin`, in the "Dirección" folder (authorized role: editor).
 *   OCU — private to `admin`: nobody else sees it.
 *   `a` and `b` are normal accounts (public sign-up); `staff` and `revisor` are editors.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";

import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonDMS } from "../../kons/kon-dms/index";

import {
  ACTORS,
  testAuth,
  dropToAppRole,
  migratedBase,
  requestAs,
  withoutInternalDetails,
  sqlAs,
} from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const saved: { key: string; type: string }[] = [];

const ids = {} as Record<string, string>;
const json = async (r: Response): Promise<any> => r.json();

function form(name: string, type: string, content = "hola") {
  const f = new FormData();
  f.append("file", new File([content], name, { type: type }));
  return f;
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
  const app = createKonDMS(
    createTestKonContext({
      db: host.db as any,
      auth: auth as any,
      storage: {
        put: async (key: string, _b: Buffer, type: string) => {
          saved.push({ key, type });
          return { key, url: `https://almacen.test/${key}`, bytes: 1 };
        },
        getSignedDownloadUrl: async (key: string) => `https://almacen.test/${key}?firma=1`,
        publicUrl: (key: string) => `https://almacen.test/${key}`,
      } as any,
    })
  );
  request = requestAs(host.mount(app));

  // Folder with a role permission (only admin creates folders).
  const dir = await request("admin", "POST", "/categories", {
    name: "Dirección",
    allowedRoles: ["editor"],
  });
  expect(dir.status).toBe(201);
  ids.folder = (await json(dir)).id;

  // R: restricted, shared with `member`.
  const r = await request("staff", "POST", "/documents", {
    title: "Plan de despidos",
    visibility: "restricted",
    allowedUserIds: [ACTORS.member.id],
    reviewerIds: [ACTORS.admin.id],
    content: "# v1\nContenido publicado <script>alert(1)</script>",
    changelog: "inicial",
  });
  expect(r.status).toBe(201);
  ids.R = (await json(r)).id;
  ids.slugR = "plan-de-despidos";
  const versions = (await json(await request("staff", "GET", `/documents/${ids.R}/versions`))).docs;
  ids.v1 = versions[0].id;
  const f1 = await request(
    "staff",
    "POST",
    `/versions/${ids.v1}/files`,
    form("acta.pdf", "application/pdf")
  );
  expect(f1.status).toBe(201);
  ids.f1 = (await json(f1)).id;
  expect((await request("staff", "POST", `/versions/${ids.v1}/submit`)).status).toBe(200);
  expect(
    (await request("admin", "POST", `/versions/${ids.v1}/review`, { decision: "approved" })).status
  ).toBe(200);
  expect((await request("admin", "POST", `/versions/${ids.v1}/publish`)).status).toBe(200);
  const v2 = await request("staff", "POST", `/documents/${ids.R}/versions`, {
    changelog: "borrador secreto",
    content: "# v2\nNombres de la lista",
  });
  expect(v2.status).toBe(201);
  ids.v2 = (await json(v2)).id;
  const f2 = await request(
    "staff",
    "POST",
    `/versions/${ids.v2}/files`,
    form("list.pdf", "application/pdf")
  );
  ids.f2 = (await json(f2)).id;

  // W: flow with reviewers `revisor` (editor) and `b` (normal account).
  const w = await request("staff", "POST", "/documents", {
    title: "Procedimiento",
    reviewerIds: [ACTORS.revisor.id, ACTORS.b.id],
    content: "pasos",
    changelog: "inicial",
  });
  ids.W = (await json(w)).id;
  ids.vW = (await json(await request("staff", "GET", `/documents/${ids.W}/versions`))).docs[0].id;

  // PUB, DIR, OCU (de admin)
  const pub = await request("admin", "POST", "/documents", {
    title: "Manual público",
    visibility: "public",
    content: "para todos",
    changelog: "x",
  });
  ids.PUB = (await json(pub)).id;
  const vPub = (await json(await request("admin", "GET", `/documents/${ids.PUB}/versions`))).docs[0]
    .id;
  await request("admin", "POST", `/versions/${vPub}/submit`);
  await request("admin", "POST", `/versions/${vPub}/review`, { decision: "approved" });
  expect((await request("admin", "POST", `/versions/${vPub}/publish`)).status).toBe(200);

  ids.DIR = (
    await json(
      await request("admin", "POST", "/documents", {
        title: "Acta de dirección",
        categoryId: ids.folder,
        visibility: "restricted",
      })
    )
  ).id;
  ids.OCU = (
    await json(
      await request("admin", "POST", "/documents", { title: "Oculto", visibility: "private" })
    )
  ).id;
});

afterAll(async () => {
  await client?.close();
});

describe("anonymous and accounts without permission", () => {
  test("anonymous → 401 on everything", async () => {
    expect((await request("anon", "GET", "/documents")).status).toBe(401);
    expect((await request("anon", "GET", `/documents/${ids.R}`)).status).toBe(401);
    expect((await request("anon", "GET", `/files/${ids.f1}/download`)).status).toBe(401);
  });

  test("any account creates neither documents nor folders", async () => {
    expect((await request("a", "POST", "/documents", { title: "spam" })).status).toBe(403);
    expect((await request("a", "POST", "/categories", { name: "x" })).status).toBe(403);
    expect((await request("staff", "POST", "/categories", { name: "x" })).status).toBe(403);
    expect((await request("a", "POST", "/import", { manifest: {}, files: [] })).status).toBe(403);
  });

  test("without access, the document does NOT exist: 404 by id, version, file, export, comments", async () => {
    for (const route of [
      `/documents/${ids.R}`,
      `/documents/${ids.R}/versions`,
      `/documents/${ids.R}/comments`,
      `/documents/${ids.R}/backlinks`,
      `/versions/${ids.v1}`,
      `/versions/${ids.v1}/export/html`,
      `/versions/${ids.v1}/export/md`,
      `/versions/${ids.v1}/diagrams`,
      `/files/${ids.f1}/download`,
      `/render/${ids.slugR}`,
    ]) {
      expect((await request("b", "GET", route)).status, route).toBe(404);
    }
    expect(
      (await request("b", "POST", `/documents/${ids.R}/comments`, { content: "hola" })).status
    ).toBe(404);
    expect((await request("b", "POST", `/documents/${ids.R}/acknowledge`, {})).status).toBe(404);
    expect((await request("b", "PATCH", `/documents/${ids.R}`, { title: "pisado" })).status).toBe(
      404
    );
    expect((await request("b", "DELETE", `/documents/${ids.R}`)).status).toBe(404);
  });

  test("listings, search and statistics do not show it", async () => {
    const list = await json(await request("b", "GET", "/documents"));
    const seen = list.docs.map((d: { id: string }) => d.id);
    expect(seen).not.toContain(ids.R);
    expect(seen).not.toContain(ids.OCU);
    expect(seen).toContain(ids.PUB);

    const search = await json(await request("b", "GET", "/search?q=despidos"));
    expect(JSON.stringify(search)).not.toContain(ids.R);

    const stats = await json(await request("b", "GET", "/stats"));
    expect(stats.documents.total).toBe(2); // PUB y W (revisor)
  });

  test("a published public document is seen by any account; a private one, by nobody", async () => {
    expect((await request("a", "GET", `/documents/${ids.PUB}`)).status).toBe(200);
    expect((await request("a", "GET", `/documents/${ids.OCU}`)).status).toBe(404);
    expect((await request("staff", "GET", `/documents/${ids.OCU}`)).status).toBe(404);
  });

  test("ids that are not uuid: 404 without Postgres details", async () => {
    const res = await request("b", "GET", "/documents/1%27%20OR%201=1--");
    expect(res.status).toBe(404);
    expect(withoutInternalDetails(await res.text())).toBe(true);
  });
});

describe("permission per document (authorized user)", () => {
  test("sees the document without the ACL and ONLY the published versions", async () => {
    const doc = await json(await request("member", "GET", `/documents/${ids.R}?versions=true`));
    expect(doc.id).toBe(ids.R);
    expect(doc.allowedUserIds).toBeUndefined();
    expect(doc.versions.map((v: { id: string }) => v.id)).toEqual([ids.v1]);
    expect((await request("member", "GET", `/versions/${ids.v2}`)).status).toBe(404);
    expect((await request("member", "GET", `/versions/${ids.v2}/export/md`)).status).toBe(404);
  });

  test("downloads the published version's file, not the draft's", async () => {
    const ok = await request("member", "GET", `/files/${ids.f1}/download`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toMatch(/^https:\/\/almacen\.test\/dms\//);
    expect((await request("member", "GET", `/files/${ids.f2}/download`)).status).toBe(404);
  });

  test("does not edit, delete, change the ACL or read who has read it", async () => {
    expect((await request("member", "PATCH", `/documents/${ids.R}`, { title: "x" })).status).toBe(
      403
    );
    expect((await request("member", "DELETE", `/documents/${ids.R}`)).status).toBe(403);
    expect(
      (await request("member", "PATCH", `/documents/${ids.R}`, { allowedUserIds: [ACTORS.b.id] }))
        .status
    ).toBe(403);
    expect((await request("member", "GET", `/documents/${ids.R}/acknowledgments`)).status).toBe(403);
    expect(
      (await request("member", "POST", `/documents/${ids.R}/versions`, { changelog: "x" })).status
    ).toBe(403);
  });

  test("confirms their reading; the owner sees the confirmations", async () => {
    expect((await request("member", "POST", `/documents/${ids.R}/acknowledge`, {})).status).toBe(
      200
    );
    const acks = await json(await request("staff", "GET", `/documents/${ids.R}/acknowledgments`));
    expect(acks.docs.map((x: { userId: string }) => x.userId)).toEqual([ACTORS.member.id]);
  });
});

describe("comments", () => {
  test("a comment is not hung on a draft you cannot see or on another document", async () => {
    const inDraft = await request("member", "POST", `/documents/${ids.R}/comments`, {
      content: "x",
      versionId: ids.v2,
    });
    expect(inDraft.status).toBe(422);
    const foreignValue = await json(
      await request("staff", "POST", `/documents/${ids.W}/comments`, { content: "de W" })
    );
    const crossed = await request("member", "POST", `/documents/${ids.R}/comments`, {
      content: "x",
      parentId: foreignValue.id,
    });
    expect(crossed.status).toBe(422);
  });

  test("the author edits; another does not (not even the document's owner); the owner moderates", async () => {
    const c = await json(
      await request("member", "POST", `/documents/${ids.R}/comments`, { content: "mío" })
    );
    expect((await request("b", "PATCH", `/comments/${c.id}`, { content: "pisado" })).status).toBe(
      404
    );
    expect((await request("staff", "PATCH", `/comments/${c.id}`, { content: "pisado" })).status).toBe(
      403
    );
    expect(
      (await request("member", "PATCH", `/comments/${c.id}`, { content: "editado" })).status
    ).toBe(200);
    expect((await request("b", "DELETE", `/comments/${c.id}`)).status).toBe(404);
    expect((await request("staff", "DELETE", `/comments/${c.id}`)).status).toBe(200);
  });

  test("a reader does not see comments made on a draft", async () => {
    await request("staff", "POST", `/documents/${ids.R}/comments`, {
      content: "nota del borrador",
      versionId: ids.v2,
    });
    const list = await json(await request("member", "GET", `/documents/${ids.R}/comments`));
    expect(JSON.stringify(list)).not.toContain("nota del borrador");
    const ofOwner = await json(await request("staff", "GET", `/documents/${ids.R}/comments`));
    expect(JSON.stringify(ofOwner)).toContain("nota del borrador");
  });
});

describe("approval flow", () => {
  test("the author does not approve themselves; the reviewer reviews but does not publish; the owner publishes", async () => {
    expect((await request("staff", "POST", `/versions/${ids.vW}/submit`)).status).toBe(200);
    const warnings = await json(await request("revisor", "GET", "/notifications"));
    expect(warnings.docs.some((n: { type: string }) => n.type === "review_requested")).toBe(true);

    expect(
      (await request("staff", "POST", `/versions/${ids.vW}/review`, { decision: "approved" })).status
    ).toBe(403);
    expect(
      (await request("a", "POST", `/versions/${ids.vW}/review`, { decision: "approved" })).status
    ).toBe(404);
    // A normal account named as reviewer does not approve: reviewing belongs to the team.
    expect(
      (await request("b", "POST", `/versions/${ids.vW}/review`, { decision: "approved" })).status
    ).toBe(403);
    expect(
      (await request("revisor", "POST", `/versions/${ids.vW}/review`, { decision: "approved" }))
        .status
    ).toBe(200);
    expect((await request("revisor", "POST", `/versions/${ids.vW}/publish`)).status).toBe(403);
    expect((await request("staff", "POST", `/versions/${ids.vW}/publish`)).status).toBe(200);
  });

  test("a published version is immutable (goodbye `force`)", async () => {
    expect(
      (await request("staff", "PATCH", `/versions/${ids.v1}`, { content: "x", force: true })).status
    ).toBe(422);
    expect((await request("staff", "PATCH", `/versions/${ids.v1}`, { content: "x" })).status).toBe(
      409
    );
    expect(
      (
        await request(
          "staff",
          "POST",
          `/versions/${ids.v1}/files`,
          form("x.pdf", "application/pdf")
        )
      ).status
    ).toBe(409);
  });

  test("the status does not skip the flow with a PATCH", async () => {
    expect((await request("staff", "PATCH", `/documents/${ids.W}`, { status: "draft" })).status).toBe(
      403
    );
    expect(
      (await request("staff", "PATCH", `/documents/${ids.W}`, { status: "archived" })).status
    ).toBe(200);
  });
});

describe("folder and group", () => {
  test("the \"Dirección\" folder (editor role) opens its document to the team, not to anyone", async () => {
    expect((await request("staff", "GET", `/documents/${ids.DIR}`)).status).toBe(200);
    expect((await request("a", "GET", `/documents/${ids.DIR}`)).status).toBe(404);
    const treeA = await json(await request("a", "GET", "/categories/tree"));
    expect(JSON.stringify(treeA)).not.toContain("Dirección");
  });

  test("an authorized group (allowedRoleIds) sees the document", async () => {
    const g = await json(
      await request("admin", "POST", "/documents", {
        title: "Para editores",
        allowedRoleIds: ["editor"],
      })
    );
    expect((await request("staff", "GET", `/documents/${g.id}`)).status).toBe(200);
    expect((await request("b", "GET", `/documents/${g.id}`)).status).toBe(404);
  });
});

describe("allowlist and impersonation", () => {
  test("an unknown field is 422 (createdById, isActive, force…)", async () => {
    expect(
      (await request("staff", "POST", "/documents", { title: "x", createdById: ACTORS.admin.id }))
        .status
    ).toBe(422);
    expect((await request("staff", "PATCH", `/documents/${ids.R}`, { isActive: false })).status).toBe(
      422
    );
  });

  test('the panel form\'s empty fields ("") do not break creation', async () => {
    const res = await request("staff", "POST", "/documents", {
      title: "Desde el panel",
      slug: "",
      categoryId: "",
      effectiveDate: "",
      visibility: "internal",
    });
    expect(res.status).toBe(201);
  });

  test("nobody creates documents in someone else's name (except admin)", async () => {
    expect(
      (await request("staff", "POST", "/documents", { title: "x", ownerId: ACTORS.a.id })).status
    ).toBe(403);
  });

  test("you cannot link to a document you cannot see (it would be an oracle)", async () => {
    const res = await request("staff", "POST", `/documents/${ids.R}/relations`, {
      targetDocumentId: ids.OCU,
      relationType: "related",
    });
    expect(res.status).toBe(422);
  });

  test("the old slug does not redirect someone who cannot see the document", async () => {
    expect(
      (await request("staff", "PATCH", `/documents/${ids.R}`, { slug: "plan-2027" })).status
    ).toBe(200);
    expect((await request("b", "GET", `/render/${ids.slugR}`)).status).toBe(404);
    expect((await request("member", "GET", `/render/${ids.slugR}`)).status).toBe(308);
  });
});

describe("files, export and diagrams", () => {
  test("the client's name never reaches the key (path traversal) and HTML/SVG are not accepted", async () => {
    const res = await request(
      "staff",
      "POST",
      `/versions/${ids.v2}/files`,
      form("../../../etc/passwd.txt", "text/plain")
    );
    expect(res.status).toBe(201);
    const f = await json(res);
    expect(f.filename).toBe("passwd.txt");
    expect(f.storagePath).toBeUndefined();
    expect(saved.at(-1)!.key).toMatch(/^dms\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.txt$/);

    for (const [name, type] of [
      ["x.html", "text/html"],
      ["x.svg", "image/svg+xml"],
      ["x.js", "application/javascript"],
    ]) {
      expect(
        (await request("staff", "POST", `/versions/${ids.v2}/files`, form(name, type))).status
      ).toBe(422);
    }
    expect(
      (
        await request(
          "b",
          "POST",
          `/versions/${ids.v2}/files`,
          form("x.pdf", "application/pdf")
        )
      ).status
    ).toBe(404);
    expect(
      (
        await request(
          "member",
          "POST",
          `/versions/${ids.v1}/files`,
          form("x.pdf", "application/pdf")
        )
      ).status
    ).toBe(403);
  });

  test("a version goes past 2 GB without overflowing (bigint, 0008), and /stats adds it up", async () => {
    const almostCap = 2 ** 31 - 2;
    await client.query(
      `UPDATE dms_document_versions SET total_size_bytes = ${almostCap} WHERE id = '${ids.v2}'`
    );
    const res = await request(
      "staff",
      "POST",
      `/versions/${ids.v2}/files`,
      form("grande.pdf", "application/pdf", "más de dos gigas")
    );
    expect(res.status).toBe(201);
    const row = await client.query<{ total: string }>(
      `SELECT total_size_bytes::text AS total FROM dms_document_versions WHERE id = '${ids.v2}'`
    );
    expect(Number(row.rows[0]!.total)).toBeGreaterThan(2 ** 31 - 1);
    const stats = await request("admin", "GET", "/stats");
    expect(stats.status).toBe(200);
    expect((await json(stats)).versions.totalSize).toBeGreaterThan(2 ** 31 - 1);
  });

  test("the exported HTML is escaped and sandboxed", async () => {
    const res = await request("member", "GET", `/versions/${ids.v1}/export/html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("HTML content with executable code is rejected on save", async () => {
    const res = await request("staff", "POST", `/documents/${ids.R}/versions`, {
      changelog: "x",
      contentFormat: "html",
      content: '<p>hola</p><img src=x onerror="fetch(1)">',
    });
    expect(res.status).toBe(422);
    const ok = await request("staff", "POST", `/documents/${ids.R}/versions`, {
      changelog: "x",
      contentFormat: "html",
      content: "<h1>Título</h1><p>texto</p>",
    });
    expect(ok.status).toBe(201);
  });

  test("an SVG with script is rejected and a reader does not touch diagrams", async () => {
    const bad = await request("staff", "POST", `/versions/${ids.v2}/diagrams`, {
      name: "x",
      renderedSvg: '<svg onload="alert(1)"></svg>',
    });
    expect(bad.status).toBe(422);
    const d = await json(
      await request("staff", "POST", `/versions/${ids.v2}/diagrams`, {
        name: "ok",
        renderedSvg: "<svg></svg>",
      })
    );
    expect((await request("member", "PATCH", `/diagrams/${d.id}`, { name: "pisado" })).status).toBe(
      404
    );
    expect((await request("b", "DELETE", `/diagrams/${d.id}`)).status).toBe(404);
  });
});

describe("audit", () => {
  test("the full one only admin; a document's, whoever runs it", async () => {
    expect((await request("b", "GET", "/audit-log")).status).toBe(403);
    expect((await request("member", "GET", `/audit-log?documentId=${ids.R}`)).status).toBe(403);
    const ofOwner = await json(await request("staff", "GET", `/audit-log?documentId=${ids.R}`));
    // Includes `member`'s view: the owner sees who has looked at THEIR document.
    expect(ofOwner.docs.some((x: { userId: string }) => x.userId === ACTORS.member.id)).toBe(
      true
    );
    expect((await request("admin", "GET", "/audit-log")).status).toBe(200);
  });
});

describe("RLS: the database filters even if the route failed", () => {
  test("b does not see R, nor its versions, nor its files", async () => {
    expect(
      await sqlAs(client, "b", "select id from dms_documents where id = $1", [ids.R])
    ).toHaveLength(0);
    expect(
      await sqlAs(client, "b", "select id from dms_document_versions where document_id = $1", [
        ids.R,
      ])
    ).toHaveLength(0);
    expect(
      await sqlAs(client, "b", "select id from dms_document_files where document_id = $1", [
        ids.R,
      ])
    ).toHaveLength(0);
  });

  test("a reader sees only the published version", async () => {
    const rows = await sqlAs<{ id: string }>(
      client,
      "member",
      "select id from dms_document_versions where document_id = $1",
      [ids.R]
    );
    expect(rows.map((f) => f.id)).toEqual([ids.v1]);
  });

  test("you cannot comment by hand on someone else's document nor read others' audit", async () => {
    await expect(
      sqlAs(
        client,
        "b",
        "insert into dms_document_comments(document_id, user_id, content) values ($1, $2, 'x')",
        [ids.R, ACTORS.b.id]
      )
    ).rejects.toThrow(/row-level security/);
    const foreign = await sqlAs(client, "b", "select id from dms_access_log where user_id <> $1", [
      ACTORS.b.id,
    ]);
    expect(foreign).toHaveLength(0);
  });

  test("user ids are stored as text", async () => {
    const [row] = await sqlAs<{ owner_id: string }>(
      client,
      "admin",
      "select owner_id from dms_documents where id = $1",
      [ids.R]
    );
    expect(row.owner_id).toBe(ACTORS.staff.id);
  });
});
