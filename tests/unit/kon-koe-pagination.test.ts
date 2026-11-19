/**
 * kon-koe: lists that grow with use take a page size
 * ============================================================================
 *
 * Notes, payment promises and outcomes take `limit` and `offset` and answer `hasMore`. A client that sends
 * neither gets what it always got: every note, and up to 200 promises or outcomes. Contacts, notices, quick
 * replies, stickers and campaigns keep their own default `limit` and take `offset` with `hasMore` too. Runs the kon on PGlite as a
 * non-superuser with row-level security (tests/unit/helpers/koe-bench.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_SECRET, koeBench, waBody, waText } from "./helpers/koe-bench";
import { ACTORS } from "./helpers/safe-kons-bench";

const json = async (res: Response): Promise<any> => res.json();

describe("kon-koe list pagination", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  let conv: { id: string };

  beforeAll(async () => {
    k = await koeBench();
    expect((await k.request("admin", "PUT", `/members/${ACTORS.member.id}`, { role: "supervisor", displayName: ACTORS.member.name })).status).toBe(200);
    const team = (await json(await k.request("member", "POST", "/teams", { slug: "support", name: "Support", assignment: "round_robin" }))).data.id;
    const channel = await k.request("admin", "POST", "/channels", { kind: "whatsapp", name: "PN1", externalId: "PN1", accountId: "waba-1", accessToken: "EAAG-test-token-123", appSecret: APP_SECRET, defaultTeamId: team });
    expect(channel.status, await channel.clone().text()).toBe(201);
    expect((await k.webhook(waBody("PN1", { messages: [waText("51911", "wamid.p1", "hola")] }))).status).toBe(200);
    await k.drain(1);
    conv = (await k.rows<{ id: string }>("SELECT c.id FROM koe_conversations c JOIN koe_identities i ON i.id = c.identity_id WHERE i.external_id = '51911'"))[0]!;
    expect(conv).toBeDefined();

    for (const body of ["primera", "segunda"]) expect((await k.request("member", "POST", `/conversations/${conv.id}/notes`, { body })).status).toBe(201);
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    for (const amountCents of [1000, 2000]) {
      expect((await k.request("member", "POST", `/conversations/${conv.id}/promises`, { amountCents, currency: "PEN", dueDate: day })).status).toBe(201);
      expect((await k.request("member", "POST", `/conversations/${conv.id}/outcomes`, { kind: "contacted" })).status).toBe(201);
    }
  });

  afterAll(async () => {
    await k?.close();
  });

  for (const list of ["notes", "promises", "outcomes"]) {
    it(`${list}: limit=1 answers one row and hasMore; no limit answers every row`, async () => {
      const page = await json(await k.request("member", "GET", `/conversations/${conv.id}/${list}?limit=1`));
      expect(page.data).toHaveLength(1);
      expect(page.hasMore).toBe(true);

      const next = await json(await k.request("member", "GET", `/conversations/${conv.id}/${list}?limit=1&offset=1`));
      expect(next.data).toHaveLength(1);
      expect(next.data[0].id).not.toBe(page.data[0].id);
      expect(next.hasMore).toBe(false);

      const all = await json(await k.request("member", "GET", `/conversations/${conv.id}/${list}`));
      expect(all.data).toHaveLength(2);
      expect(all.hasMore).toBe(false);
    });
  }

  describe("lists with their own default limit take offset", () => {
    beforeAll(async () => {
      const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
      const [channel] = await k.rows<{ id: string }>("SELECT id FROM koe_channels LIMIT 1");
      await k.rows("INSERT INTO koe_templates (id, channel_id, name, language, category, status) VALUES ('t-page', $1, 'paging', 'es', 'utility', 'approved')", [channel!.id]);
      for (const n of [1, 2, 3]) {
        await k.rows("INSERT INTO koe_contacts (id, display_name, phone, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [`ct-page-${n}`, `Paged ${n}`, `5190000000${n}`, at(n)]);
        await k.rows("INSERT INTO koe_notices (id, user_id, kind, title, created_at) VALUES ($1, $2, 'assigned', $3, $4)", [`nt-page-${n}`, ACTORS.member.id, `Notice ${n}`, at(n)]);
        await k.rows("INSERT INTO koe_media (id, kind, mime, status, storage_key, created_at) VALUES ($1, 'sticker', 'image/webp', 'ready', $2, $3)", [`md-page-${n}`, `koe/page-${n}.webp`, at(n)]);
        await k.rows("INSERT INTO koe_stickers (id, media_id, name, created_at) VALUES ($1, $2, $3, $4)", [`st-page-${n}`, `md-page-${n}`, `sticker ${n}`, at(n)]);
        await k.rows("INSERT INTO koe_campaigns (id, channel_id, name, template_id, created_at, updated_at) VALUES ($1, $2, $3, 't-page', $4, $4)", [`cp-page-${n}`, channel!.id, `Campaign ${n}`, at(n)]);
        const qr = await k.request("member", "POST", "/quick-replies", { shortcut: `page${n}`, title: `Page ${n}`, body: `Reply ${n}` });
        expect(qr.status, await qr.clone().text()).toBe(201);
      }
    });

    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
    const lists: Array<[string, string]> = [
      ["contacts", "/contacts?q=Paged"],
      ["notices", "/notices"],
      ["quick replies", "/quick-replies?shortcut=page"],
      ["stickers", "/stickers"],
      ["campaigns", "/campaigns"],
    ];
    for (const [name, route] of lists) {
      it(`${name}: no parameters answer what they did; limit=1&offset=1 is the second row; pages join to the whole`, async () => {
        const all = await json(await k.request("member", "GET", route));
        expect(all.hasMore).toBe(false);
        expect(all.data.length).toBeGreaterThanOrEqual(3);

        const first = await json(await k.request("member", "GET", `${route}${route.includes("?") ? "&" : "?"}limit=1`));
        expect(ids(first.data)).toEqual(ids(all.data.slice(0, 1)));
        expect(first.hasMore).toBe(true);

        const second = await json(await k.request("member", "GET", `${route}${route.includes("?") ? "&" : "?"}limit=1&offset=1`));
        expect(ids(second.data)).toEqual(ids(all.data.slice(1, 2)));
        expect(second.hasMore).toBe(true);

        const pages: Array<{ id: string }> = [];
        for (let offset = 0; ; offset += 1) {
          const page = await json(await k.request("member", "GET", `${route}${route.includes("?") ? "&" : "?"}limit=1&offset=${offset}`));
          pages.push(...page.data);
          if (!page.hasMore) break;
        }
        expect(ids(pages)).toEqual(ids(all.data));
      });
    }

    it("newest first stays newest first: notices, stickers and campaigns", async () => {
      expect(ids((await json(await k.request("member", "GET", "/notices"))).data).slice(0, 3)).toEqual(["nt-page-3", "nt-page-2", "nt-page-1"]);
      expect(ids((await json(await k.request("member", "GET", "/stickers"))).data)).toEqual(["st-page-3", "st-page-2", "st-page-1"]);
      expect(ids((await json(await k.request("member", "GET", "/campaigns"))).data)).toEqual(["cp-page-3", "cp-page-2", "cp-page-1"]);
      expect((await k.request("member", "GET", "/campaigns?offset=-1")).status).toBe(422);
    });
  });

  it("a page size beyond the cap is refused", async () => {
    expect((await k.request("member", "GET", `/conversations/${conv.id}/promises?limit=201`)).status).toBe(422);
    expect((await k.request("member", "GET", `/conversations/${conv.id}/notes?limit=0`)).status).toBe(422);
  });
});
