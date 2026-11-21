/**
 * kon-odoo — REAL routes and queue handlers on PGlite, a non-superuser role and per-request row
 * security, against an Odoo that lives in memory (tests/unit/helpers/odoo-bench.ts).
 *
 * What is checked is what would hurt in a shop: a forged notice, a variant Odoo recreated, stock
 * that is on hand but reserved, an order sent twice, a product deleted in Odoo, and who may see
 * what.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOdooClient, OdooError } from "../../kons/kon-odoo/odoo.client";
import { planProduct, productSlug, slugOdooId } from "../../kons/kon-odoo/odoo.mirror";
import { odooSchedules } from "../../kons/kon-odoo/odoo.queues";
import { parseAttributes } from "../../kons/kon-odoo/odoo.routes";
import type { OdooCapabilities } from "../../kons/kon-odoo/odoo.schema";
import { signBody, validSignature } from "../../kons/kon-odoo/odoo.webhook";

import { odooBench, PURGE_SECRET, seedShop, WEBHOOK_SECRET, type OdooBench } from "./helpers/odoo-bench";

// ── The client: no database, no bench ─────────────────────────────────────────

describe("the JSON-2 client", () => {
  function recording(answer: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createOdooClient({
      baseUrl: "https://erp.test/",
      apiKey: "k-123",
      database: "shop",
      context: { lang: "es_ES" },
      transport: async (url, init) => {
        calls.push({ url, init });
        return answer();
      },
    });
    return { client, calls };
  }

  it("posts named arguments to /json/2/<model>/<method> with the key and the database", async () => {
    const { client, calls } = recording(() => Response.json([{ id: 1, name: "A" }]));
    const rows = await client.searchRead("res.partner", { domain: [["is_company", "=", true]], fields: ["name"], limit: 5 });

    expect(rows).toEqual([{ id: 1, name: "A" }]);
    expect(calls[0].url).toBe("https://erp.test/json/2/res.partner/search_read");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("bearer k-123");
    expect(headers["x-odoo-database"]).toBe("shop");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      domain: [["is_company", "=", true]],
      fields: ["name"],
      limit: 5,
      context: { lang: "es_ES" },
    });
    // A redirect would carry the key somewhere else.
    expect(calls[0].init.redirect).toBe("error");
  });

  it("sends no key of its own when the transport adds the credential", async () => {
    const calls: RequestInit[] = [];
    const client = createOdooClient({
      baseUrl: "https://erp.test",
      transport: async (_url, init) => {
        calls.push(init);
        return Response.json(3);
      },
    });
    expect(await client.searchCount("res.partner")).toBe(3);
    expect((calls[0].headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("turns Odoo's errors into kinds a caller can branch on", async () => {
    const cases: Array<[number, unknown, string, boolean]> = [
      [401, { name: "werkzeug.exceptions.Unauthorized", message: "Invalid apikey" }, "auth", false],
      [403, { name: "odoo.exceptions.AccessError", message: "no" }, "access", false],
      [404, { name: "werkzeug.exceptions.NotFound", message: "no model" }, "not-found", false],
      [422, { name: "odoo.exceptions.ValidationError", message: "bad" }, "validation", false],
      [500, { name: "odoo.exceptions.MissingError", message: "gone" }, "missing", false],
      [502, "<html>bad gateway</html>", "unavailable", true],
    ];
    for (const [status, body, kind, retryable] of cases) {
      const { client } = recording(
        () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
      );
      const error = await client.read("res.partner", [1], ["name"]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OdooError);
      expect((error as OdooError).kind).toBe(kind);
      expect((error as OdooError).retryable).toBe(retryable);
    }
  });

  it("treats a silence and a 200 that is not JSON as Odoo not answering", async () => {
    const silent = createOdooClient({
      baseUrl: "https://erp.test",
      transport: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(((await silent.searchCount("res.partner").catch((e: unknown) => e)) as OdooError).retryable).toBe(true);

    const { client } = recording(() => new Response("<html>login</html>", { status: 200 }));
    expect(((await client.searchCount("res.partner").catch((e: unknown) => e)) as OdooError).kind).toBe("unavailable");
  });

  it("drops the address's trailing slashes, fast even with very many", async () => {
    const { withoutTrailingSlashes } = await import("../../kons/kon-odoo/odoo.client");
    expect(withoutTrailingSlashes("https://erp.test///")).toBe("https://erp.test");
    expect(withoutTrailingSlashes("https://erp.test")).toBe("https://erp.test");
    const started = Date.now();
    expect(withoutTrailingSlashes("x" + "/".repeat(200_000) + "y")).toHaveLength(200_002);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("refuses a private method or a strange model before any request", async () => {
    const { client, calls } = recording(() => Response.json(true));
    await expect(client.call("res.partner", "_read_group")).rejects.toThrow(TypeError);
    await expect(client.call("res.partner/../x", "read")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

// ── Pure pieces ───────────────────────────────────────────────────────────────

describe("planning a product", () => {
  const capabilities: OdooCapabilities = {
    stock: true,
    website: true,
    variants: true,
    loyalty: false,
    payments: false,
    bridge: false,
    fields: {},
    checkedAt: "2026-11-20T00:00:00.000Z",
  };

  it("sells what is free to use, not what is on hand, and counts a negative as none", () => {
    const plan = planProduct(
      { id: 1, name: "Card", active: true, sale_ok: true, is_published: true, is_storable: true, list_price: 5 },
      [
        { id: 10, lst_price: 5, free_qty: -2, qty_available: 3, active: true },
        { id: 11, lst_price: 7, free_qty: 1, qty_available: 1, active: true },
      ],
      new Map(),
      capabilities,
      "USD"
    );
    expect(plan.qtyFree).toBe("1.0000");
    expect(plan.inStock).toBe(true);
    expect(plan.minPrice).toBe("5.0000");
    expect(plan.maxPrice).toBe("7.0000");
    expect(plan.variants[0].qtyFree).toBe("-2.0000");
    expect(plan.currency).toBe("USD");
  });

  it("a product Odoo does not count can always be sold and has no quantity", () => {
    const plan = planProduct(
      { id: 2, name: "Service", active: true, sale_ok: true, is_published: true, is_storable: false, type: "service" },
      [{ id: 20, lst_price: 3, free_qty: 0, active: true }],
      new Map(),
      capabilities,
      null
    );
    expect(plan.qtyFree).toBeNull();
    expect(plan.inStock).toBe(true);
    expect(plan.variants[0].qtyFree).toBeNull();
  });

  it("is public only when Odoo publishes it, where Odoo has that switch", () => {
    const template = { id: 3, name: "X", active: true, sale_ok: true, is_published: false };
    expect(planProduct(template, [], new Map(), capabilities, null).published).toBe(false);
    expect(planProduct(template, [], new Map(), { ...capabilities, website: false }, null).published).toBe(true);
    expect(planProduct({ ...template, is_published: true, sale_ok: false }, [], new Map(), capabilities, null).published).toBe(false);
  });

  it("builds slugs that end in the Odoo id and reads the id back", () => {
    expect(productSlug("Camiseta Básica", 10)).toBe("camiseta-basica-10");
    expect(productSlug("???", 7)).toBe("product-7");
    expect(slugOdooId("an-old-name-10")).toBe(10);
    expect(slugOdooId("10")).toBe(10);
    expect(slugOdooId("no-id-here")).toBeNull();
  });

  it("reads attribute filters from the query", () => {
    expect(parseAttributes("Color:Red,Color:Blue, Size : M,broken,:x")).toEqual({ Color: ["Red", "Blue"], Size: ["M"] });
    expect(parseAttributes(undefined)).toEqual({});
  });

  it("checks a signature in constant time and refuses anything malformed", () => {
    const body = '{"id":"1","changes":[]}';
    expect(validSignature(body, signBody(body, "s3cret-s3cret-s3cret-s3cret"), "s3cret-s3cret-s3cret-s3cret")).toBe(true);
    expect(validSignature(body, signBody(body, "another-secret-another-secret"), "s3cret-s3cret-s3cret-s3cret")).toBe(false);
    expect(validSignature(body, "sha256=abc", "x")).toBe(false);
    expect(validSignature(body, null, "x")).toBe(false);
  });

  it("signs exactly as the Odoo bridge module does (the vector its own tests pin)", () => {
    // kitsuden-odoo-bridge tests_pure/test_notice.py asserts the same value for Python's `sign`.
    const body = '{"id":"abc:1-2","changes":[{"model":"product.template","ids":[10,11]}]}';
    const vector = "sha256=2697060edc9af3940b30a90c0996dcf5d3a80f2a1c8b042e3429f32b98cdb8e6";
    expect(signBody(body, "s3cret-s3cret-s3cret-s3cret")).toBe(vector);
    expect(validSignature(body, vector, "s3cret-s3cret-s3cret-s3cret")).toBe(true);
  });
});

// ── The kon ───────────────────────────────────────────────────────────────────

describe("kon-odoo", () => {
  let bench: OdooBench;

  beforeAll(async () => {
    bench = await odooBench();
    seedShop(bench.odoo);
  }, 120_000);

  afterAll(async () => {
    await bench?.close();
  });

  const named = (name: string) => bench.events.filter((event) => event.name === name);

  describe("settings and permissions", () => {
    it("only the team sees the state; an agent needs the kon's scope", async () => {
      expect((await bench.request("anon", "GET", "/status")).status).toBe(401);
      expect((await bench.request("a", "GET", "/status")).status).toBe(403);
      expect((await bench.request({ agent: ["blog:*"] }, "GET", "/status")).status).toBe(403);
      expect((await bench.request({ agent: ["odoo:*"] }, "GET", "/status")).status).toBe(200);

      const status = await (await bench.request("staff", "GET", "/status")).json();
      expect(status.configured).toBe(true);
      expect(status.host).toBe("erp.test");
      expect(status.capabilities).toBeNull();
      expect(status.mirror).toEqual({ products: 0, published: 0, variants: 0 });
    });

    it("a notice cannot be verified before a secret is stored", async () => {
      const response = await bench.notice({ id: "early", changes: [] });
      expect(response.status).toBe(409);
    });

    it("stores secrets sealed and never gives them back", async () => {
      expect((await bench.request("a", "PATCH", "/settings", { purgeSource: "x" })).status).toBe(403);
      expect((await bench.request("staff", "PATCH", "/settings", { purgeUrl: "javascript:alert(1)" })).status).toBe(422);
      expect((await bench.request("staff", "PATCH", "/settings", { webhookSecret: "short" })).status).toBe(422);

      const response = await bench.request("staff", "PATCH", "/settings", {
        webhookSecret: WEBHOOK_SECRET,
        purgeSecret: PURGE_SECRET,
        purgeUrl: "https://shop.test/api/catalog/purge",
        purgeSource: "odoo",
        keyExpiresOn: "2026-11-27",
        lang: "es_ES",
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(WEBHOOK_SECRET);
      expect(text).not.toContain(PURGE_SECRET);
      expect(JSON.parse(text)).toMatchObject({ hasWebhookSecret: true, hasPurgeSecret: true, lang: "es_ES" });

      const [row] = await bench.rows<{ webhook_secret: { kon: string; valueEncrypted: string } }>(
        "SELECT webhook_secret FROM odoo_settings"
      );
      expect(row.webhook_secret.kon).toBe("kon-odoo");
      expect(JSON.stringify(row)).not.toContain(WEBHOOK_SECRET);
    });

    it("asks Odoo what it has installed", async () => {
      const response = await bench.request("staff", "POST", "/connection/check");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.capabilities).toMatchObject({ stock: true, website: true, variants: true, loyalty: true, bridge: false });
      expect(body.currency).toBe("USD");
    });
  });

  describe("change notices", () => {
    it("refuses a notice that is not signed with the secret", async () => {
      const before = bench.jobs.length;
      expect((await bench.notice({ id: "forged", changes: [{ model: "product.template", ids: [10] }] }, "not-the-secret-not-the-secret")).status).toBe(401);
      expect((await bench.request("anon", "POST", "/webhook", '{"id":"x","changes":[]}')).status).toBe(401);
      expect(bench.jobs.length).toBe(before);
    });

    it("refuses a signed notice with the wrong shape", async () => {
      expect((await bench.notice({ id: "bad", changes: [{ model: "res.users", ids: [1] }] })).status).toBe(400);
      expect((await bench.notice({ changes: [] })).status).toBe(400);
    });

    it("reads the named products back from Odoo into the mirror", async () => {
      const response = await bench.notice({ id: "first", changes: [{ model: "product.template", ids: [10, 11, 12] }] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: 3, duplicate: false });
      const ran = await bench.drain();
      expect(ran.map((job) => job.name)).toContain("templates");

      const products = await bench.rows<Record<string, unknown>>(
        "SELECT odoo_id, slug, min_price, max_price, qty_free, in_stock, published, currency, attributes FROM odoo_products ORDER BY odoo_id"
      );
      expect(products).toHaveLength(3);
      expect(products[0]).toMatchObject({
        odoo_id: 10,
        slug: "camiseta-basica-10",
        min_price: "19.9900",
        max_price: "21.5000",
        qty_free: "4.0000",
        in_stock: true,
        published: true,
        currency: "USD",
        attributes: { Color: ["Red", "Blue"] },
      });
      // A service: no quantity, always for sale.
      expect(products[1]).toMatchObject({ odoo_id: 11, qty_free: null, in_stock: true });
      expect(products[2]).toMatchObject({ odoo_id: 12, published: false });

      const variants = await bench.rows<Record<string, unknown>>(
        "SELECT odoo_id, sku, options, qty_free, qty_on_hand, visible FROM odoo_variants ORDER BY odoo_id"
      );
      expect(variants[0]).toMatchObject({ odoo_id: 100, sku: "TEE-RED", options: { Color: "Red" }, qty_free: "4.0000", qty_on_hand: "5.0000", visible: true });
      // Two on hand, none free: reserved.
      expect(variants[1]).toMatchObject({ odoo_id: 101, qty_free: "0.0000", qty_on_hand: "2.0000" });
      expect(variants[3]).toMatchObject({ odoo_id: 120, visible: false });

      expect(named("odoo:product.changed").at(-1)?.data.products).toHaveLength(3);
    });

    it("tells the site which products changed, signed", async () => {
      const purge = bench.purges.at(-1)!;
      expect(purge.url).toBe("https://shop.test/api/catalog/purge");
      expect(JSON.parse(purge.body)).toEqual({ source: "odoo", ids: ["10", "11", "12"] });
      expect(purge.signature).toBe(signBody(purge.body, PURGE_SECRET));
    });

    it("acknowledges a notice it has already seen and does nothing", async () => {
      const response = await bench.notice({ id: "first", changes: [{ model: "product.template", ids: [10] }] });
      expect(await response.json()).toEqual({ accepted: 0, duplicate: true });
      expect(bench.jobs).toHaveLength(0);
    });
  });

  describe("the public catalog", () => {
    it("lists what is published, to anyone, without calling Odoo", async () => {
      const calls = bench.odoo.calls.length;
      const response = await bench.request("anon", "GET", "/catalog/products");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(2);
      expect(body.docs.map((doc: { slug: string }) => doc.slug)).toEqual(["camiseta-basica-10", "gift-wrapping-11"]);
      expect(body.docs[0]).toMatchObject({
        id: "10",
        title: "Camiseta Básica",
        price: { amount: "19.9900", max: "21.5000", currency: "USD" },
        availability: "InStock",
        category: { id: "5", title: "Clothing" },
      });
      expect(bench.odoo.calls.length).toBe(calls);
    });

    it("hides the unpublished even from the team: the shop's API is the shop", async () => {
      const body = await (await bench.request("admin", "GET", "/catalog/products")).json();
      expect(body.docs.map((doc: { id: string }) => doc.id)).not.toContain("12");
      expect((await bench.request("admin", "GET", "/catalog/products/unreleased-hoodie-12")).status).toBe(404);
    });

    it("row security says the same to a query that forgets the filter", async () => {
      const { sqlAs } = await import("./helpers/safe-kons-bench");
      const anon = await sqlAs<{ odoo_id: number }>(bench.client, "anon", "SELECT odoo_id FROM odoo_products ORDER BY odoo_id", []);
      expect(anon.map((row) => row.odoo_id)).toEqual([10, 11]);
      const orders = await sqlAs(bench.client, "a", "SELECT * FROM odoo_settings", []);
      expect(orders).toHaveLength(0);
    });

    it("filters by text, category subtree, attribute, price and stock", async () => {
      const ids = async (query: string) =>
        (await (await bench.request("anon", "GET", `/catalog/products?${query}`)).json()).docs.map((doc: { id: string }) => doc.id);

      expect(await ids("search=camiseta")).toEqual(["10"]);
      expect(await ids("search=WRAP")).toEqual(["11"]);
      expect(await ids("search=100%25")).toEqual([]);
      expect(await ids("category=all-1")).toEqual(["10", "11"]);
      expect(await ids("category=5")).toEqual(["10"]);
      expect(await ids("category=does-not-exist")).toEqual([]);
      expect(await ids("attributes=Color:Blue")).toEqual(["10"]);
      expect(await ids("attributes=Color:Green")).toEqual([]);
      expect(await ids("priceMax=5")).toEqual(["11"]);
      expect(await ids("priceMin=10")).toEqual(["10"]);
      expect(await ids("sort=price-asc")).toEqual(["11", "10"]);
      expect(await ids("sort=price-desc")).toEqual(["10", "11"]);
    });

    it("counts the matches in each category", async () => {
      const body = await (await bench.request("anon", "GET", "/catalog/products?category=5&facets=true")).json();
      expect(body.total).toBe(1);
      expect(body.facets[0].name).toBe("category");
      expect(body.facets[0].values.map((v: { label: string; count: number }) => [v.label, v.count])).toEqual([
        ["Clothing", 1],
        ["Services", 1],
      ]);
    });

    it("finds a product by an old slug and answers its variants", async () => {
      const response = await bench.request("anon", "GET", "/catalog/products/the-name-it-had-before-10");
      expect(response.status).toBe(200);
      const product = await response.json();
      expect(product.slug).toBe("camiseta-basica-10");
      expect(product.variants).toHaveLength(2);
      expect(product.variants[0]).toMatchObject({ sku: "TEE-RED", options: { Color: "Red" }, availability: "InStock" });
      expect(product.variants[1]).toMatchObject({ sku: "TEE-BLUE", availability: "OutOfStock" });
    });

    it("lists categories and the sitemap's slugs", async () => {
      const categories = await (await bench.request("anon", "GET", "/catalog/categories")).json();
      expect(categories.docs.map((c: { title: string; count: number }) => [c.title, c.count])).toEqual([
        ["All", 0],
        ["Clothing", 1],
        ["Services", 1],
      ]);
      const first = await (await bench.request("anon", "GET", "/catalog/summaries?limit=1")).json();
      expect(first.docs).toHaveLength(1);
      const rest = await (await bench.request("anon", "GET", `/catalog/summaries?after=${first.docs[0].id}`)).json();
      expect(rest.docs.map((d: { id: string }) => d.id)).toEqual(["11"]);
    });
  });

  describe("what Odoo does to a catalog", () => {
    it("a stock change is a notice about the variant, and reaches the product", async () => {
      bench.odoo.find("product.product", 100)!.free_qty = 0;
      bench.events.length = 0;
      await bench.changed("product.product", 100);

      const [product] = await bench.rows<{ in_stock: boolean; qty_free: string }>(
        "SELECT in_stock, qty_free FROM odoo_products WHERE odoo_id = 10"
      );
      expect(product).toEqual({ in_stock: false, qty_free: "0.0000" });
      expect(named("odoo:stock.changed")).toHaveLength(1);
      expect(named("odoo:price.changed")).toHaveLength(0);

      const body = await (await bench.request("anon", "GET", "/catalog/products?inStock=true")).json();
      expect(body.docs.map((doc: { id: string }) => doc.id)).toEqual(["11"]);
    });

    it("a price change is announced as one", async () => {
      bench.odoo.find("product.product", 100)!.lst_price = 17.5;
      bench.odoo.find("product.product", 100)!.free_qty = 4;
      bench.events.length = 0;
      await bench.changed("product.product", 100);
      expect(named("odoo:price.changed")).toHaveLength(1);
      const [product] = await bench.rows<{ min_price: string }>("SELECT min_price FROM odoo_products WHERE odoo_id = 10");
      expect(product.min_price).toBe("17.5000");
    });

    it("follows a variant Odoo recreated under a new id, by its reference", async () => {
      const [before] = await bench.rows<{ id: string }>("SELECT id FROM odoo_variants WHERE odoo_id = 101");
      // Odoo deletes the variant and makes it again: same reference, new id.
      const old = bench.odoo.find("product.product", 101)!;
      bench.odoo.remove("product.product", 101);
      bench.odoo.add("product.product", { ...old, id: 201 });
      await bench.changed("product.template", 10);

      const rows = await bench.rows<{ id: string; odoo_id: number; previous_odoo_ids: number[]; active: boolean }>(
        "SELECT id, odoo_id, previous_odoo_ids, active FROM odoo_variants WHERE sku = 'TEE-BLUE'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: before.id, odoo_id: 201, previous_odoo_ids: [101], active: true });

      const conflicts = await bench.rows<{ kind: string; resolved_at: string | null }>(
        "SELECT kind, resolved_at FROM odoo_conflicts WHERE reference = 'TEE-BLUE'"
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].kind).toBe("variant_recreated");
      expect(conflicts[0].resolved_at).not.toBeNull();
    });

    it("hides a variant that is gone and has no reference to follow", async () => {
      bench.odoo.add("product.product", {
        id: 300,
        product_tmpl_id: [10, "x"],
        default_code: false,
        lst_price: 30,
        active: true,
        product_template_attribute_value_ids: [],
        free_qty: 1,
        qty_available: 1,
      });
      await bench.changed("product.template", 10);
      bench.odoo.remove("product.product", 300);
      await bench.changed("product.template", 10);
      const [row] = await bench.rows<{ active: boolean; visible: boolean }>(
        "SELECT active, visible FROM odoo_variants WHERE odoo_id = 300"
      );
      expect(row).toEqual({ active: false, visible: false });
    });

    it("reports one reference on two variants that can be sold", async () => {
      bench.odoo.find("product.product", 110)!.default_code = "TEE-RED";
      await bench.changed("product.template", 11);
      const open = await (await bench.request("staff", "GET", "/conflicts")).json();
      const conflict = open.docs.find((doc: { kind: string }) => doc.kind === "duplicate_reference");
      expect(conflict).toMatchObject({ reference: "TEE-RED", resolvedAt: null });

      // An order by that reference cannot tell them apart.
      const order = await bench.request("staff", "POST", "/orders", {
        clientRef: "web-ambiguous",
        customer: { email: "x@example.com", name: "X" },
        lines: [{ sku: "TEE-RED", quantity: 1 }],
      });
      expect(order.status).toBe(422);

      bench.odoo.find("product.product", 110)!.default_code = "WRAP";
      await bench.changed("product.template", 11);
      expect((await bench.request("a", "POST", `/conflicts/${conflict.id}/resolve`)).status).toBe(403);
      const resolved = await bench.request("staff", "POST", `/conflicts/${conflict.id}/resolve`);
      expect(resolved.status).toBe(200);
      expect((await resolved.json()).resolvedAt).not.toBeNull();
    });

    it("a full walk reads everything and hides what Odoo no longer has", async () => {
      bench.odoo.remove("product.template", 11);
      bench.odoo.remove("product.product", 110);
      // The walk compares against when each row was last read: this one was read long ago.
      await bench.rows("UPDATE odoo_products SET synced_at = now() - interval '1 hour'");
      bench.events.length = 0;

      expect((await bench.request("a", "POST", "/sync")).status).toBe(403);
      const response = await bench.request("staff", "POST", "/sync");
      expect(response.status).toBe(202);
      expect((await response.json()).started).toBe(true);
      // A second request while it runs answers the same walk.
      const again = await (await bench.request("staff", "POST", "/sync")).json();
      expect(again.started).toBe(false);

      await bench.drain();
      const status = await (await bench.request("staff", "GET", "/status")).json();
      expect(status.lastRun).toMatchObject({ status: "done", products: 2, retired: 1 });
      expect(status.lastFullSyncAt).not.toBeNull();

      const [gone] = await bench.rows<{ active: boolean; published: boolean }>(
        "SELECT active, published FROM odoo_products WHERE odoo_id = 11"
      );
      expect(gone).toEqual({ active: false, published: false });
      expect((await bench.request("anon", "GET", "/catalog/products/gift-wrapping-11")).status).toBe(404);
      expect(named("odoo:sync.completed")).toHaveLength(1);
    });

    it("a walk Odoo refuses is closed with the reason, not left running", async () => {
      await bench.rows("UPDATE odoo_sync_runs SET status = 'done' WHERE status = 'running'");
      await bench.request("staff", "POST", "/sync");
      bench.odoo.failNext = new OdooError({ kind: "access", status: 403, message: "You are not allowed", model: "x", method: "y" });
      await bench.drain();
      const status = await (await bench.request("staff", "GET", "/status")).json();
      expect(status.lastRun.status).toBe("failed");
      expect(status.lastRun.error).toContain("cannot read product.template");
      // What Odoo has installed is not overwritten by a refusal: the hoodie stays unpublished.
      expect(status.capabilities).toMatchObject({ website: true, stock: true });
    });
  });

  describe("orders", () => {
    const order = {
      clientRef: "web-0001",
      customer: { email: "Ana@Example.com", name: "Ana Pérez", countryCode: "PA" },
      lines: [{ sku: "TEE-RED", quantity: 2 }],
    };
    let id: string;

    it("only the team, or the shop's own key, takes an order", async () => {
      expect((await bench.request("anon", "POST", "/orders", order)).status).toBe(401);
      expect((await bench.request("a", "POST", "/orders", order)).status).toBe(403);
      expect((await bench.request({ agent: ["blog:*"] }, "POST", "/orders", order)).status).toBe(403);
    });

    it("refuses lines that name nothing for sale", async () => {
      const bad = (lines: unknown) => bench.request("staff", "POST", "/orders", { ...order, clientRef: "web-bad1", lines });
      expect((await bad([{ sku: "NOPE", quantity: 1 }])).status).toBe(422);
      expect((await bad([{ sku: "HOOD", quantity: 1 }])).status).toBe(422);
      expect((await bad([{ quantity: 1 }])).status).toBe(422);
      expect((await bad([])).status).toBe(422);
    });

    it("stores the order and queues it; the same reference is the same order", async () => {
      const first = await bench.request({ agent: ["odoo:*"] }, "POST", "/orders", order);
      expect(first.status).toBe(201);
      const body = await first.json();
      id = body.id;
      expect(body).toMatchObject({ status: "pending", odooId: null, customer: { email: "ana@example.com" } });
      expect(body.lines[0]).toMatchObject({ odooProductId: 100, sku: "TEE-RED", quantity: "2" });

      const second = await bench.request("staff", "POST", "/orders", order);
      expect(second.status).toBe(200);
      expect((await second.json()).id).toBe(id);
      expect(bench.jobs.filter((job) => job.name === "order")).toHaveLength(1);
    });

    it("makes it in Odoo once, with the customer, and reads back Odoo's numbers", async () => {
      bench.events.length = 0;
      await bench.drain();

      const orders = bench.odoo.models["sale.order"];
      expect(orders).toHaveLength(1);
      expect(orders[0].client_order_ref).toBe("web-0001");
      const partner = bench.odoo.models["res.partner"].at(-1)!;
      expect(partner).toMatchObject({ email: "ana@example.com", name: "Ana Pérez", country_id: 170 });

      const body = await (await bench.request("staff", "GET", `/orders/${id}`)).json();
      expect(body).toMatchObject({
        status: "created",
        odooId: orders[0].id,
        odooName: orders[0].name,
        amountTotal: "35.0000",
        currency: "USD",
        paymentUrl: `https://erp.test/my/orders/${orders[0].id}?access_token=portal-token`,
      });
      expect(body.lines[0].unitPrice).toBe("17.5000");
      expect(named("odoo:sale_order.created")).toHaveLength(1);
      expect(named("odoo:sale_order.confirmed")).toHaveLength(0);
    });

    it("a retry finds the order Odoo already has instead of making a second one", async () => {
      await bench.rows("UPDATE odoo_orders SET odoo_id = NULL, status = 'pending' WHERE id = $1", [id]);
      bench.jobs.push({ queue: "kon-odoo-push", name: "order", payload: { orderId: id }, attempts: 1 });
      await bench.drain();
      expect(bench.odoo.models["sale.order"]).toHaveLength(1);
      expect(bench.odoo.models["res.partner"].filter((p) => p.email === "ana@example.com")).toHaveLength(1);
    });

    it("announces the order when Odoo confirms it, once, with what a ledger needs", async () => {
      const sale = bench.odoo.models["sale.order"][0];
      sale.state = "sale";
      bench.events.length = 0;
      await bench.changed("sale.order", sale.id);

      expect((await (await bench.request("staff", "GET", `/orders/${id}`)).json()).status).toBe("confirmed");
      const [event] = named("odoo:sale_order.confirmed");
      expect(event.data).toMatchObject({
        odooId: sale.id,
        name: sale.name,
        orderId: id,
        clientRef: "web-0001",
        date: "2026-11-20",
        amountUntaxed: "35.0000",
        amountTotal: "35.0000",
        currency: "USD",
        partner: { name: "Ana Pérez", email: "ana@example.com" },
      });
      expect((event.data.lines as Array<Record<string, unknown>>)[0]).toMatchObject({
        quantity: "2.0000",
        unitPrice: "17.5000",
        subtotal: "35.0000",
        sku: "TEE-RED",
      });

      // Another write to the same order in Odoo is not news.
      await bench.changed("sale.order", sale.id);
      expect(named("odoo:sale_order.confirmed")).toHaveLength(1);
    });

    it("announces an order made in Odoo itself, which this kon never took", async () => {
      const partner = bench.odoo.nextId();
      bench.odoo.add("res.partner", { id: partner, name: "Walk-in", email: false, phone: false, vat: false });
      const line = bench.odoo.nextId();
      bench.odoo.add("sale.order.line", {
        id: line,
        name: "Camiseta",
        product_id: [100, "x"],
        product_uom_qty: 1,
        price_unit: 17.5,
        price_subtotal: 17.5,
        price_total: 17.5,
        display_type: false,
      });
      const sale = bench.odoo.nextId();
      bench.odoo.add("sale.order", {
        id: sale,
        name: "S09999",
        state: "sale",
        partner_id: [partner, "Walk-in"],
        date_order: "2026-11-21 12:00:00",
        client_order_ref: false,
        amount_untaxed: 17.5,
        amount_tax: 0,
        amount_total: 17.5,
        currency_id: [1, "USD"],
        order_line: [line],
      });
      bench.events.length = 0;
      await bench.changed("sale.order", sale);
      expect(named("odoo:sale_order.confirmed")[0].data).toMatchObject({ odooId: sale, orderId: null, clientRef: null });
    });

    it("an order Odoo refuses fails with Odoo's words and is not retried", async () => {
      const response = await bench.request("staff", "POST", "/orders", { ...order, clientRef: "web-0002" });
      const refused = (await response.json()).id;
      // The customer is found (one call), the order is searched (one call), then Odoo says no.
      const original = bench.odoo.create.bind(bench.odoo);
      bench.odoo.create = async (model, values) => {
        if (model === "sale.order") {
          throw new OdooError({ kind: "validation", status: 422, message: "Product is archived", model, method: "create" });
        }
        return original(model, values);
      };
      await bench.drain();
      bench.odoo.create = original;

      const body = await (await bench.request("staff", "GET", `/orders/${refused}`)).json();
      expect(body).toMatchObject({ status: "failed", error: "Product is archived", odooId: null });
      const status = await (await bench.request("staff", "GET", "/status")).json();
      expect(status.failedOrders).toBe(1);
    });

    it("lets a silence from Odoo go up, so the queue tries again", async () => {
      const response = await bench.request("staff", "POST", "/orders", { ...order, clientRef: "web-0003" });
      const pending = (await response.json()).id;
      bench.odoo.failNext = new OdooError({ kind: "unavailable", status: 0, message: "timeout", model: "x", method: "y" });
      await expect(bench.drain()).rejects.toThrow("timeout");
      const body = await (await bench.request("staff", "GET", `/orders/${pending}`)).json();
      expect(body.status).toBe("pending");
    });

    it("an id that is not a UUID gives 404, not a 500", async () => {
      expect((await bench.request("staff", "GET", "/orders/not-a-uuid")).status).toBe(404);
    });

    it("lists orders a page at a time and says whether there is more", async () => {
      expect((await bench.request("a", "GET", "/orders")).status).toBe(403);
      const first = await (await bench.request("staff", "GET", "/orders?limit=2")).json();
      expect(first.docs).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      const rest = await (await bench.request("staff", "GET", "/orders?limit=2&offset=2")).json();
      expect(rest.hasMore).toBe(false);
      const seen = [...first.docs, ...rest.docs].map((doc: { id: string }) => doc.id);
      expect(new Set(seen).size).toBe(seen.length);
      const failed = await (await bench.request("staff", "GET", "/orders?status=failed")).json();
      expect(failed.docs.map((doc: { clientRef: string }) => doc.clientRef)).toEqual(["web-0002"]);
    });
  });

  describe("payments and store credit", () => {
    it("announces a customer payment with the orders it settled", async () => {
      const sale = bench.odoo.models["sale.order"][0];
      const partner = (sale.partner_id as [number, string])[0];
      bench.odoo.add("account.move", { id: 700, invoice_origin: `${sale.name}, S09999` });
      bench.odoo.add(
        "account.payment",
        {
          id: 800,
          amount: 35,
          currency_id: [1, "USD"],
          partner_id: [partner, "Ana"],
          date: "2026-11-22",
          state: "paid",
          payment_type: "inbound",
          memo: "INV/2026/0001",
          reconciled_invoice_ids: [700],
        },
        { id: 801, amount: 10, currency_id: [1, "USD"], partner_id: false, date: "2026-11-22", state: "draft", payment_type: "inbound", reconciled_invoice_ids: [] },
        { id: 802, amount: 10, currency_id: [1, "USD"], partner_id: false, date: "2026-11-22", state: "paid", payment_type: "outbound", reconciled_invoice_ids: [] }
      );
      bench.events.length = 0;
      await bench.changed("account.payment", 800, 801, 802);

      const events = named("odoo:payment.received");
      // A draft is not money received, and a payment to a vendor is not a customer's.
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({
        paymentId: 800,
        amount: "35.0000",
        currency: "USD",
        date: "2026-11-22",
        reference: "INV/2026/0001",
        partner: { email: "ana@example.com" },
      });
      expect((events[0].data.orders as Array<{ name: string }>).map((o) => o.name).sort()).toEqual([sale.name, "S09999"].sort());
    });

    it("finds the order of a payment the bridge recorded before there was an invoice", async () => {
      const sale = bench.odoo.models["sale.order"][0];
      bench.odoo.add("account.payment", {
        id: 810,
        amount: 5,
        currency_id: [1, "USD"],
        partner_id: false,
        date: "2026-11-23",
        state: "in_process",
        payment_type: "inbound",
        memo: `${sale.name} tilopay pay-9`,
        reconciled_invoice_ids: [],
      });
      bench.events.length = 0;
      await bench.changed("account.payment", 810);
      expect(named("odoo:payment.received")[0].data.orders).toEqual([{ odooId: sale.id, name: sale.name }]);
    });

    it("reads a customer's store credit without its codes", async () => {
      const partner = bench.odoo.models["res.partner"].find((p) => p.email === "ana@example.com")!;
      bench.odoo.add(
        "loyalty.card",
        { id: 1, partner_id: [partner.id, "Ana"], "program_id.program_type": "ewallet", points: 20, expiration_date: false, code: "SECRET-CODE" },
        { id: 2, partner_id: [partner.id, "Ana"], "program_id.program_type": "ewallet", points: 5, expiration_date: "2020-01-01", code: "OLD" },
        { id: 3, partner_id: [partner.id, "Ana"], "program_id.program_type": "loyalty", points: 300, expiration_date: false, code: "PTS" }
      );
      expect((await bench.request("a", "GET", "/wallet?email=ana@example.com")).status).toBe(403);
      const response = await bench.request("staff", "GET", "/wallet?email=ANA@example.com");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("SECRET-CODE");
      expect(JSON.parse(text)).toEqual({
        balance: "20.0000",
        currency: "USD",
        cards: [{ id: 1, balance: "20.0000", expiresOn: null }],
      });
      expect((await bench.request("staff", "GET", "/wallet?email=nobody@example.com")).status).toBe(404);
    });
  });

  describe("products made on demand and images", () => {
    it("creates a product in Odoo only when it is not there, and mirrors it", async () => {
      const body = { sku: "LOTUS-NM", name: "Black Lotus (NM)", price: 9999.5 };
      expect((await bench.request("a", "POST", "/products/provision", body)).status).toBe(403);
      expect((await bench.request("staff", "POST", "/products/provision", body)).status).toBe(202);
      // Odoo makes the variant with the template; the double is told to.
      const original = bench.odoo.create.bind(bench.odoo);
      bench.odoo.create = async (model, values) => {
        const id = await original(model, values);
        if (model === "product.template") {
          Object.assign(bench.odoo.find(model, id)!, { active: true, is_published: true, is_storable: true, currency_id: [1, "USD"] });
          bench.odoo.add("product.product", {
            id: bench.odoo.nextId(),
            product_tmpl_id: [id, "x"],
            default_code: values.default_code as string,
            lst_price: values.list_price as number,
            active: true,
            product_template_attribute_value_ids: [],
            free_qty: 0,
            qty_available: 0,
          });
        }
        return id;
      };
      await bench.drain();
      const templates = bench.odoo.models["product.template"].filter((t) => t.default_code === "LOTUS-NM");
      expect(templates).toHaveLength(1);

      // Asked again: Odoo already has it.
      await bench.request("staff", "POST", "/products/provision", body);
      await bench.drain();
      bench.odoo.create = original;
      expect(bench.odoo.models["product.template"].filter((t) => t.default_code === "LOTUS-NM")).toHaveLength(1);

      const [row] = await bench.rows<{ min_price: string; in_stock: boolean }>(
        "SELECT min_price, in_stock FROM odoo_products WHERE sku = 'LOTUS-NM'"
      );
      expect(row).toEqual({ min_price: "9999.5000", in_stock: false });
    });

    it("copies a product's picture into this Kitsuden's storage", async () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
      bench.odoo.find("product.template", 10)!.image_1024 = png.toString("base64");
      bench.odoo.find("product.template", 10)!.write_date = "2026-11-23 08:00:00";
      await bench.changed("product.template", 10);

      expect(bench.files.get("odoo/products/10.png")?.equals(png)).toBe(true);
      const product = await (await bench.request("anon", "GET", "/catalog/products/x-10")).json();
      expect(product.image).toBe("https://files.test/odoo/products/10.png?v=2026-11-23%2008%3A00%3A00");

      // Something that is not a picture is not served as one.
      bench.odoo.find("product.template", 10)!.image_1024 = Buffer.from("<svg onload=alert(1)>").toString("base64");
      bench.odoo.find("product.template", 10)!.write_date = "2026-11-23 09:00:00";
      await bench.changed("product.template", 10);
      expect(bench.files.has("odoo/products/10.png")).toBe(false);
      expect((await (await bench.request("anon", "GET", "/catalog/products/x-10")).json()).image).toBeNull();
    });
  });

  describe("schedules", () => {
    const schedule = (id: string) => odooSchedules.find((s) => s.id === id)!;

    it("warns when the key is about to expire", async () => {
      bench.events.length = 0;
      await schedule("housekeeping").run(bench.ctx, { scheduledAt: new Date("2026-11-20T07:40:00Z") });
      expect(named("odoo:key.expiring")[0].data).toEqual({ expiresOn: "2026-11-27", daysLeft: 7 });

      bench.events.length = 0;
      await schedule("housekeeping").run(bench.ctx, { scheduledAt: new Date("2026-10-01T07:40:00Z") });
      expect(named("odoo:key.expiring")).toHaveLength(0);
    });

    it("forgets old notices", async () => {
      await bench.rows("UPDATE odoo_notices SET received_at = now() - interval '45 days' WHERE notice_id = 'first'");
      await schedule("housekeeping").run(bench.ctx, { scheduledAt: new Date() });
      expect(await bench.rows("SELECT 1 FROM odoo_notices WHERE notice_id = 'first'")).toHaveLength(0);
    });

    it("the nightly reconcile starts a walk", async () => {
      await bench.rows("UPDATE odoo_sync_runs SET status = 'done' WHERE status = 'running'");
      bench.jobs.length = 0;
      await schedule("reconcile").run(bench.ctx, { scheduledAt: new Date() });
      expect(bench.jobs.map((job) => job.name)).toEqual(["full"]);
      await bench.drain();
    });
  });

  describe("when the site cannot be told", () => {
    it("a refusal is final; an outage is retried", async () => {
      bench.setPurgeStatus(401);
      bench.jobs.push({ queue: "kon-odoo-push", name: "purge", payload: { ids: [10] }, attempts: 1 });
      await expect(bench.drain()).rejects.toThrow(/refused/);
      bench.setPurgeStatus(503);
      bench.jobs.push({ queue: "kon-odoo-push", name: "purge", payload: { ids: [10] }, attempts: 1 });
      await expect(bench.drain()).rejects.toThrow(/503/);
      bench.setPurgeStatus(200);
    });
  });
});
