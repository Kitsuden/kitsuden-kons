/**
 * kon-listings — REAL routes on PGlite, a non-superuser role and per-request row security
 * ============================================================================
 *
 * Mounts `createListingsRouter` behind the host's RLS transaction (`rlsHost`), with the kon's
 * migration, and checks the policy AND the database:
 *
 *   · anyone searches what is published; only the team sees drafts and writes;
 *   · attributes are checked against the vertical on every write, and what a vertical requires
 *     only when the listing is published;
 *   · a portal reads its feed by token, sees only published listings, and an incomplete listing is
 *     left out and reported instead of breaking the file;
 *   · a visitor may ask about a published listing, never read the inquiries; a bot filling the
 *     hidden field stores nothing.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { buildFeed, loadPortals, portals, xmlText, type FeedListing } from "../../kons/kon-listings/listings.feeds";
import { registerListingsPolicy } from "../../kons/kon-listings/listings.policy";
import { createListingsRouter, INQUIRY_EVENT } from "../../kons/kon-listings/listings.routes";
import { attributeIssues, loadVerticals, publishIssues, verticals } from "../../kons/kon-listings/listings.verticals";

import { dropToAppRole, migratedBase, requestAs, sqlAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const emitted: Array<[string, unknown]> = [];

beforeAll(async () => {
  client = await migratedBase("kon-listings", ["0000_initial.sql"]);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({
    db: host.db as never,
    auth: auth as never,
    events: { emit: (name: string, data: unknown) => emitted.push([name, data]), on: () => {}, off: () => {} } as never,
  });
  const app = host.mount(createListingsRouter(ctx));
  app.onError((err) =>
    err instanceof AppError
      ? Response.json({ error: err.message, details: err.details }, { status: err.status })
      : Response.json({ error: String(err) }, { status: 500 })
  );
  request = requestAs(app);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerListingsPolicy();
});

const HOUSE = "https://img.example.com/house.jpg";

/** A complete real-estate listing, ready to publish. */
function apartment(overrides: Record<string, unknown> = {}) {
  return {
    vertical: "real-estate",
    title: "Apartment & terrace <Costa del Este>",
    description: "Three bedrooms, sea view. ]]> not a CDATA end.",
    price: 1850,
    currency: "USD",
    city: "Panama City",
    district: "Costa del Este",
    country: "PA",
    images: [{ url: HOUSE, title: "Living room" }],
    attributes: { operation: "rent", propertyType: "apartment", bedrooms: 3, bathrooms: 2, areaM2: 140, furnished: true },
    ...overrides,
  };
}

describe("kon-listings: listings", () => {
  let published: { id: string; slug: string };
  let draft: { id: string; slug: string };

  it("anyone can read the verticals", async () => {
    const res = await request("anon", "GET", "/verticals");
    expect(res.status).toBe(200);
    const ids = (await res.json()).docs.map((v: { id: string }) => v.id);
    expect(ids).toEqual(["jobs", "real-estate", "vehicles"]);
  });

  it("only the team creates", async () => {
    expect((await request("anon", "POST", "/", apartment())).status).toBe(401);
    expect((await request("a", "POST", "/", apartment())).status).toBe(403);
    expect((await request({ agent: ["blog:*"] }, "POST", "/", apartment())).status).toBe(403);
  });

  it("attributes are checked against the vertical on every write", async () => {
    let res = await request("staff", "POST", "/", apartment({ vertical: "boats" }));
    expect(res.status).toBe(422);
    res = await request("staff", "POST", "/", apartment({ status: "draft", attributes: { bedroom: 2 } }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("bedroom");
    res = await request("staff", "POST", "/", apartment({ status: "draft", attributes: { bedrooms: "many" } }));
    expect(res.status).toBe(422);
    res = await request("staff", "POST", "/", apartment({ status: "draft", attributes: { operation: "lease" } }));
    expect(res.status).toBe(422);
    // https only: a portal downloads the pictures.
    res = await request("staff", "POST", "/", apartment({ images: [{ url: "http://img.example.com/a.jpg" }] }));
    expect(res.status).toBe(422);
  });

  it("a draft may be incomplete; publishing needs what the vertical requires", async () => {
    const res = await request("staff", "POST", "/", {
      vertical: "real-estate",
      title: "Lot in Boquete",
      attributes: { propertyType: "land" },
    });
    expect(res.status).toBe(201);
    draft = await res.json();
    expect(draft).toMatchObject({ status: "draft", publishedAt: null });

    const refused = await request("staff", "PATCH", `/${draft.id}`, { status: "published" });
    expect(refused.status).toBe(422);
    const body = JSON.stringify(await refused.json());
    for (const missing of ["price", "currency", "city", "images", "operation"]) expect(body).toContain(missing);

    const created = await request("admin", "POST", "/", apartment({ status: "published", reference: "PTY-001" }));
    expect(created.status).toBe(201);
    published = await created.json();
    expect(published).toMatchObject({ status: "published", price: 1850, reference: "PTY-001" });
    expect(published.slug).toMatch(/^apartment-terrace-costa-del-este-[a-f0-9]{6}$/);
  });

  it("an agent with the kon's scope is part of the team", async () => {
    const res = await request({ agent: ["listings:*"] }, "POST", "/", {
      vertical: "vehicles",
      title: "Toyota Hilux 2021",
      attributes: { make: "Toyota", model: "Hilux", year: 2021, condition: "used", mileageKm: 42000 },
    });
    expect(res.status).toBe(201);
  });

  it("anyone searches what is published, and only that", async () => {
    const docs = async (actor: Parameters<typeof request>[0], query = "") =>
      (await (await request(actor, "GET", `/${query}`)).json()).docs.map((d: { id: string }) => d.id);

    expect(await docs("anon")).toEqual([published.id]);
    // Asking for drafts does not show them to someone outside the team.
    expect(await docs("anon", "?status=draft")).toEqual([published.id]);
    expect(await docs("staff")).toContain(draft.id);
    expect(await docs("staff", "?status=draft")).not.toContain(published.id);

    expect(await docs("anon", "?city=panama%20city")).toEqual([published.id]);
    expect(await docs("anon", "?city=David")).toEqual([]);
    expect(await docs("anon", "?attr=operation:rent")).toEqual([published.id]);
    expect(await docs("anon", "?attr=operation:sale")).toEqual([]);
    expect(await docs("anon", "?priceMin=1000&priceMax=2000")).toEqual([published.id]);
    expect(await docs("anon", "?priceMax=1000")).toEqual([]);
    expect(await docs("anon", "?q=terrace")).toEqual([published.id]);
    expect(await docs("anon", "?q=%25")).toEqual([]);
    expect(await docs("anon", "?vertical=vehicles")).toEqual([]);

    // Row security says the same even without the route's filter.
    const rows = await sqlAs(client, "anon", "SELECT id FROM listings_items");
    expect(rows.map((r) => r.id)).toEqual([published.id]);
  });

  it("a listing that is not published is a 404 to everyone but the team", async () => {
    expect((await request("anon", "GET", `/${published.id}`)).status).toBe(200);
    expect((await request("anon", "GET", `/${draft.id}`)).status).toBe(404);
    expect((await request("staff", "GET", `/${draft.id}`)).status).toBe(200);
    expect((await request("anon", "GET", `/by-slug/${published.slug}`)).status).toBe(200);
    expect((await request("anon", "GET", `/by-slug/${draft.slug}`)).status).toBe(404);
    expect((await request("anon", "GET", "/not-a-uuid")).status).toBe(404);
  });

  it("an update merges attributes, and a published listing stays complete", async () => {
    let res = await request("staff", "PATCH", `/${published.id}`, { attributes: { parking: 2, furnished: null } });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.attributes).toMatchObject({ operation: "rent", bedrooms: 3, parking: 2 });
    expect(updated.attributes).not.toHaveProperty("furnished");
    expect(updated.publishedAt).toBe(published.publishedAt ?? updated.publishedAt);

    // Taking away what a published listing needs is refused, not silently unpublished.
    res = await request("staff", "PATCH", `/${published.id}`, { images: [] });
    expect(res.status).toBe(422);
    res = await request("staff", "PATCH", `/${published.id}`, { attributes: { operation: null } });
    expect(res.status).toBe(422);

    expect((await request("a", "PATCH", `/${published.id}`, { title: "x" })).status).toBe(403);
    expect((await request("a", "PATCH", `/${draft.id}`, { title: "x" })).status).toBe(404);
  });
});

describe("kon-listings: portal feeds", () => {
  let feed: { id: string; path: string };
  let token: string;
  const listingUrl = "https://agency.example.com/homes/{slug}";

  it("only the team sees and creates feeds", async () => {
    expect((await request("anon", "GET", "/feeds")).status).toBe(401);
    expect((await request("a", "GET", "/feeds")).status).toBe(403);
    expect((await request("a", "POST", "/feeds", { portal: "trovit", vertical: "real-estate", listingUrl })).status).toBe(403);
    expect((await request("anon", "GET", "/portals")).status).toBe(401);
  });

  it("a feed needs a known portal, a vertical it takes and a usable listing URL", async () => {
    expect((await request("staff", "POST", "/feeds", { portal: "nope", vertical: "real-estate", listingUrl })).status).toBe(422);
    expect((await request("staff", "POST", "/feeds", { portal: "trovit", vertical: "boats", listingUrl })).status).toBe(422);
    for (const url of ["https://agency.example.com/homes", "http://agency.example.com/homes/{slug}"]) {
      expect((await request("staff", "POST", "/feeds", { portal: "trovit", vertical: "real-estate", listingUrl: url })).status).toBe(422);
    }
  });

  it("creates one feed per portal and vertical, with a public path", async () => {
    const res = await request("staff", "POST", "/feeds", {
      portal: "trovit",
      vertical: "real-estate",
      listingUrl,
      settings: { agencyName: "Casa & Co", contactPhone: "+507 6000-0000" },
    });
    expect(res.status).toBe(201);
    feed = await res.json();
    expect(feed.path).toMatch(/^\/api\/listings\/feed\/[a-f0-9]{48}$/);
    token = feed.path.split("/").at(-1)!;
    expect((await request("staff", "POST", "/feeds", { portal: "trovit", vertical: "real-estate", listingUrl })).status).toBe(409);

    // A visitor cannot read the feeds table, token included.
    expect(await sqlAs(client, "anon", "SELECT token FROM listings_feeds")).toEqual([]);
    expect(await sqlAs(client, "a", "SELECT token FROM listings_feeds")).toEqual([]);
  });

  it("the portal reads published listings, escaped, in its format", async () => {
    const res = await request("anon", "GET", `/feed/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<trovit>");
    expect((xml.match(/<ad>/g) ?? []).length).toBe(1);
    expect(xml).toContain("<title>Apartment &amp; terrace &lt;Costa del Este&gt;</title>");
    expect(xml).toContain("]]&gt; not a CDATA end.");
    expect(xml).toContain("<type>For Rent</type>");
    expect(xml).toContain('<price currency="USD" period="monthly">1850</price>');
    expect(xml).toContain('<floor_area unit="meters">140</floor_area>');
    expect(xml).toMatch(/<url>https:\/\/agency\.example\.com\/homes\/apartment-terrace-costa-del-este-[a-f0-9]{6}<\/url>/);
    expect(xml).toContain(`<picture><picture_url>${HOUSE}</picture_url><picture_title>Living room</picture_title></picture>`);
    expect(xml).toContain("<agency>Casa &amp; Co</agency>");
    // Drafts and other verticals stay out.
    expect(xml).not.toContain("Boquete");
    expect(xml).not.toContain("Hilux");
  });

  it("an incomplete listing is left out and reported, not sent broken", async () => {
    // Published, but without a description: Trovit's <content> is required.
    const res = await request("staff", "POST", "/", apartment({ status: "published", title: "No description", description: null }));
    expect(res.status).toBe(201);
    const check = await (await request("staff", "GET", `/feeds/${feed.id}/check`)).json();
    expect(check).toMatchObject({ portal: "trovit", verified: false, included: 1 });
    expect(check.skipped).toEqual([expect.objectContaining({ title: "No description", missing: ["content"] })]);
    const xml = await (await request("anon", "GET", `/feed/${token}`)).text();
    expect(xml).not.toContain("No description");
  });

  it("a wrong token, a switched-off feed and a rotated token are 404", async () => {
    expect((await request("anon", "GET", `/feed/${"0".repeat(48)}`)).status).toBe(404);
    expect((await request("anon", "GET", "/feed/not-a-token")).status).toBe(404);

    expect((await request("staff", "PATCH", `/feeds/${feed.id}`, { enabled: false })).status).toBe(200);
    expect((await request("anon", "GET", `/feed/${token}`)).status).toBe(404);
    const rotated = await (await request("staff", "PATCH", `/feeds/${feed.id}`, { enabled: true, rotateToken: true })).json();
    expect((await request("anon", "GET", `/feed/${token}`)).status).toBe(404);
    expect((await request("anon", "GET", rotated.path.replace("/api/listings", ""))).status).toBe(200);
  });

  it("the team deletes a feed", async () => {
    expect((await request("a", "DELETE", `/feeds/${feed.id}`)).status).toBe(403);
    expect((await request("staff", "DELETE", `/feeds/${feed.id}`)).status).toBe(204);
    expect((await request("staff", "DELETE", `/feeds/${feed.id}`)).status).toBe(404);
  });
});

describe("kon-listings: inquiries", () => {
  let listing: { id: string };
  let hidden: { id: string };

  beforeAll(async () => {
    listing = await (await request("staff", "POST", "/", apartment({ status: "published", title: "For inquiries" }))).json();
    hidden = await (await request("staff", "POST", "/", { vertical: "real-estate", title: "Hidden draft" })).json();
  });

  it("a visitor asks about a published listing, and the CRM hears about it", async () => {
    emitted.length = 0;
    const res = await request("anon", "POST", `/${listing.id}/inquiries`, {
      name: "Ana",
      email: "ana@example.com",
      phone: "+507 6111-1111",
      message: "Is it still available?",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
    expect(emitted).toEqual([
      [INQUIRY_EVENT, expect.objectContaining({ listingId: listing.id, email: "ana@example.com", vertical: "real-estate" })],
    ]);
  });

  it("not about a draft, and a bot filling the hidden field stores nothing", async () => {
    const ask = { name: "Bot", email: "bot@example.com", message: "Buy now" };
    expect((await request("anon", "POST", `/${hidden.id}/inquiries`, ask)).status).toBe(404);
    emitted.length = 0;
    const res = await request("anon", "POST", `/${listing.id}/inquiries`, { ...ask, website: "http://spam.example" });
    expect(res.status).toBe(202);
    expect(emitted).toEqual([]);
    expect((await request("anon", "POST", `/${listing.id}/inquiries`, { ...ask, email: "nope" })).status).toBe(422);
  });

  it("only the team reads inquiries", async () => {
    expect((await request("anon", "GET", "/inquiries")).status).toBe(401);
    expect((await request("a", "GET", "/inquiries")).status).toBe(403);
    const docs = (await (await request("staff", "GET", `/inquiries?listingId=${listing.id}`)).json()).docs;
    expect(docs).toEqual([expect.objectContaining({ name: "Ana", email: "ana@example.com" })]);
    // Row security: a visitor or a customer sees no row even with a raw query.
    expect(await sqlAs(client, "anon", "SELECT email FROM listings_inquiries")).toEqual([]);
    expect(await sqlAs(client, "a", "SELECT email FROM listings_inquiries")).toEqual([]);

    expect((await request("a", "DELETE", `/inquiries/${docs[0].id}`)).status).toBe(403);
    expect((await request("staff", "DELETE", `/inquiries/${docs[0].id}`)).status).toBe(204);
    expect((await (await request("staff", "GET", `/inquiries?listingId=${listing.id}`)).json()).docs).toEqual([]);
  });

  it("deleting a listing takes its inquiries with it", async () => {
    await request("anon", "POST", `/${listing.id}/inquiries`, { name: "Luis", email: "luis@example.com", message: "Hi" });
    expect((await request("a", "DELETE", `/${listing.id}`)).status).toBe(403);
    expect((await request("staff", "DELETE", `/${listing.id}`)).status).toBe(204);
    expect((await (await request("staff", "GET", `/inquiries?listingId=${listing.id}`)).json()).docs).toEqual([]);
  });
});

describe("kon-listings: the inquiries list pages (0.2.0)", () => {
  let listing: { id: string };
  const route = () => `/inquiries?listingId=${listing.id}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON answers
  const get = async (path: string): Promise<any> => {
    const res = await request("staff", "GET", path);
    expect(res.status, path).toBe(200);
    return res.json();
  };
  const ids = (docs: Array<{ id: string }>) => docs.map((d) => d.id);

  beforeAll(async () => {
    listing = await (await request("staff", "POST", "/", apartment({ status: "published", title: "Paged inquiries" }))).json();
    for (const name of ["First", "Second", "Third"]) {
      const res = await request("anon", "POST", `/${listing.id}/inquiries`, { name, email: `${name.toLowerCase()}@example.com`, message: "Hi" });
      expect(res.status).toBe(202);
    }
  });

  it("no parameters answer what they did, newest first, with hasMore false", async () => {
    const all = await get(route());
    expect(all.docs).toHaveLength(3);
    expect(all.hasMore).toBe(false);
    const times = all.docs.map((d: { createdAt: string }) => d.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("limit=1 has more; limit=1&offset=1 is the second row; the pages join to the whole list", async () => {
    const all = await get(route());
    const first = await get(`${route()}&limit=1`);
    expect(ids(first.docs)).toEqual(ids(all.docs.slice(0, 1)));
    expect(first.hasMore).toBe(true);

    const second = await get(`${route()}&limit=1&offset=1`);
    expect(ids(second.docs)).toEqual(ids(all.docs.slice(1, 2)));
    expect(second.hasMore).toBe(true);

    const last = await get(`${route()}&limit=2&offset=1`);
    expect(ids(last.docs)).toEqual(ids(all.docs.slice(1)));
    expect(last.hasMore).toBe(false);

    expect((await request("staff", "GET", `${route()}&offset=-1`)).status).toBe(422);
    expect(await get("/inquiries?listingId=not-a-uuid")).toEqual({ docs: [], hasMore: false });
  });
});

describe("kon-listings: verticals and portals are data", () => {
  it("every shipped portal maps every shipped vertical, and all start unverified", () => {
    for (const portal of portals().values()) {
      expect(Object.keys(portal.verticals).sort()).toEqual([...verticals().keys()].sort());
      expect(portal.verified).toBe(false);
    }
    expect([...portals().keys()]).toEqual(["mitula", "trovit"]);
  });

  it("every mapping reads a field that exists", () => {
    const columns = new Set(["id", "reference", "url", "title", "description", "price", "currency", "country", "region", "city", "district", "address", "postcode", "latitude", "longitude", "publishedAt", "updatedAt"]);
    const feedKeys = new Set(["agencyName", "contactPhone", "contactEmail"]);
    for (const portal of portals().values()) {
      for (const [vertical, mappings] of Object.entries(portal.verticals)) {
        const fields = new Set(verticals().get(vertical)!.fields.map((f) => f.key));
        const sources = mappings.flatMap((m) => [m.from, ...Object.values(m.attributes ?? {}).map((a) => a.from)]).filter(Boolean) as string[];
        for (const from of sources) {
          const [head, key] = from.split(".");
          const known =
            (head === "attributes" && fields.has(key)) || (head === "feed" && feedKeys.has(key)) || (!key && columns.has(head));
          expect(known, `${portal.id}/${vertical}: ${from}`).toBe(true);
        }
      }
    }
  });

  it("a broken portal or vertical file is refused by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "listings-"));
    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify({ id: "bad", name: "Bad", verified: false, root: "x", item: "y", verticals: { jobs: [{ element: "a b", from: "title" }] } })
    );
    expect(() => loadPortals(dir)).toThrow(/bad\.json/);
    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify({ id: "bad", name: "Bad", verified: false, root: "x", item: "y", verticals: { jobs: [{ element: "a", from: "title", value: "x" }] } })
    );
    expect(() => loadPortals(dir)).toThrow(/exactly one/);

    const vdir = mkdtempSync(join(tmpdir(), "verticals-"));
    writeFileSync(join(vdir, "boats.json"), JSON.stringify({ id: "boats", name: "Boats", fields: [{ key: "hull", label: "Hull", type: "select" }] }));
    expect(() => loadVerticals(vdir)).toThrow(/boats\.json.*options/);
  });

  it("XML text is escaped and stripped of characters XML forbids", () => {
    expect(xmlText(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
    expect(xmlText("bell\u0007 and null\u0000 gone, tab\tkept")).toBe("bell and null gone, tab\tkept");
  });

  it("the feed formats values the way the mapping says", () => {
    const listing: FeedListing = {
      id: "1",
      reference: null,
      url: "https://x.example/1",
      title: "Car",
      description: "Fine",
      price: "19990.00",
      currency: "USD",
      country: null,
      region: null,
      city: "David",
      district: null,
      address: null,
      postcode: null,
      latitude: null,
      longitude: null,
      images: [{ url: "https://img.example/1.jpg" }],
      attributes: { make: "Kia", model: "Rio", year: 2019, condition: "certified", mileageKm: 51000 },
      publishedAt: new Date("2026-03-04T10:00:00Z"),
      updatedAt: new Date("2026-03-04T10:00:00Z"),
    };
    const built = buildFeed(portals().get("trovit")!, "vehicles", [listing]);
    expect(built).toMatchObject({ included: 1, skipped: [] });
    expect(built.xml).toContain('<price currency="USD">19990</price>');
    expect(built.xml).toContain("<date>04/03/2026</date>");
    expect(built.xml).toContain("<is_new>0</is_new>");
    expect(built.xml).toContain('<mileage unit="kilometers">51000</mileage>');
    expect(() => buildFeed(portals().get("trovit")!, "boats", [listing])).toThrow(/boats/);
  });

  it("a vertical checks types on drafts and requirements on publishing", () => {
    const estate = verticals().get("real-estate")!;
    expect(attributeIssues(estate, { bedrooms: 2 }, false)).toEqual([]);
    expect(attributeIssues(estate, { bedrooms: 2 }, true).map((i) => i.field).sort()).toEqual(["operation", "propertyType"]);
    expect(attributeIssues(estate, { amenities: ["pool", "moat"] }, false)).not.toEqual([]);
    expect(publishIssues(estate, { price: 1, currency: "USD", city: " ", images: [], attributes: { operation: "sale", propertyType: "house" } }).map((i) => i.field)).toEqual(["city", "images"]);
  });
});
