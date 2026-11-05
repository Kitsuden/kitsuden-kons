/**
 * Idempotency-Key: the core's generic middleware
 * ============================================================================
 *
 * Tested against a small Hono app (to count executions) and against the
 * REAL kon-ecommerce router, which already had its own idempotency in the database
 * (the two layers have to coexist without breaking their tests).
 *
 *   - replay: status, allowlisted headers and body, without executing;
 *   - same key with a different body → 422; with another actor → another operation;
 *   - concurrency: two at once → one executes, the other 409;
 *   - expiry: after the TTL the key is free again;
 *   - Valkey down → Postgres table (PGlite, created automatically); with nothing → 503
 *     fail-closed without executing, or fail-open if configured;
 *   - `Set-Cookie` and bodies with secrets are never stored.
 *
 * The Valkey store is tested against a real Valkey only if
 * `KITSUDEN_TEST_VALKEY_URL` is given (own container; skipped in CI).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  inMemoryStore,
  postgresStore,
  valkeyStore,
  idempotencyConfig,
  containsSecret,
  type IdempotencyStore,
  type MinimalValkeyClient,
  type IdempotencyConfig,
  type SqlQuery,
} from "../../.kitsuden/apps/api/src/lib/idempotency";
import { readSqlFile } from "../../.kitsuden/apps/api/src/lib/sql-file";
import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { idempotency } from "../../.kitsuden/apps/api/src/middleware/idempotency";
import { httpProblems } from "../../.kitsuden/apps/api/src/middleware/problems-http";
import { registerShopPolicies } from "../../kons/kon-ecommerce/shop.policy";
import { createShopRouter } from "../../kons/kon-ecommerce/shop.routes";

const CONFIG: IdempotencyConfig = {
  lifetimeMs: 60_000,
  blockingMs: 10_000,
  maxResponseBytes: 4096,
  failureMode: "closed",
};

/** A store that always fails (Valkey down, database down). */
const down = (name: string): IdempotencyStore => ({
  name,
  reserve: async () => {
    throw new Error(`${name} down`);
  },
  complete: async () => {
    throw new Error(`${name} down`);
  },
  release: async () => {
    throw new Error(`${name} down`);
  },
});

interface Mounting {
  app: Hono;
  runs: () => number;
}

/** Toy app: counts how many times each write is executed. */
function mount(stores: () => IdempotencyStore[], config = CONFIG): Mounting {
  let n = 0;
  const app = new Hono();
  app.use("*", httpProblems());
  app.use("*", async (c, next) => {
    const who = c.req.header("x-test-user");
    if (who) c.set("user" as never, { id: who } as never);
    await next();
  });
  app.use("/api/*", idempotency({ stores, config }));

  app.post("/api/cosas", async (c) => {
    n++;
    const body = await c.req.json();
    c.header("Location", `/api/cosas/${n}`);
    c.header("Set-Cookie", "sesion=secreta; HttpOnly");
    c.header("X-Interna", "no-se-repite");
    return c.json({ id: n, received: body }, 201);
  });
  app.post("/api/lento", async (c) => {
    n++;
    await new Promise((r) => setTimeout(r, 150));
    return c.json({ id: n }, 201);
  });
  app.post("/api/claves", (c) => {
    n++;
    return c.json({ id: `k${n}`, token: `kitsuden_agent_${"x".repeat(32)}` }, 201);
  });
  app.post("/api/falla", (c) => {
    n++;
    return c.json({ error: "boom" }, 500);
  });
  app.post("/api/invalida", (c) => {
    n++;
    return c.json({ error: "campo obligatorio" }, 422);
  });
  app.delete("/api/cosas/:id", (c) => {
    n++;
    return c.body(null, 204);
  });
  return { app, runs: () => n };
}

const send = (
  app: Hono,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST"
) =>
  app.request(route, {
    method: method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("replay", () => {
  it("the retry with the same key and body repeats status, headers and body without executing", async () => {
    const memory = inMemoryStore();
    const { app, runs: executions } = mount(() => [memory]);

    const h = { "idempotency-key": "op-0001-crear" };
    const r1 = await send(app, "/api/cosas", { name: "a" }, h);
    const r2 = await send(app, "/api/cosas", { name: "a" }, h);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(executions()).toBe(1);
    expect(await r2.json()).toEqual(await r1.json());
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(r1.headers.get("idempotent-replayed")).toBeNull();
    expect(r2.headers.get("location")).toBe("/api/cosas/1");
    expect(r2.headers.get("content-type")).toContain("application/json");
    // Neither the cookie nor the headers outside the allowlist are replayed
    expect(r2.headers.get("set-cookie")).toBeNull();
    expect(r2.headers.get("x-interna")).toBeNull();
  });

  it("without a header it does nothing (each request is executed)", async () => {
    const { app, runs: executions } = mount(() => [inMemoryStore()]);
    await send(app, "/api/cosas", { name: "a" });
    await send(app, "/api/cosas", { name: "a" });
    expect(executions()).toBe(2);
  });

  it("DELETE with a key: the 204 is replayed without deleting again", async () => {
    const memory = inMemoryStore();
    const { app, runs: executions } = mount(() => [memory]);
    const h = { "idempotency-key": "borrar-7-0001" };
    const r1 = await send(app, "/api/cosas/7", undefined, h, "DELETE");
    const r2 = await send(app, "/api/cosas/7", undefined, h, "DELETE");
    expect([r1.status, r2.status]).toEqual([204, 204]);
    expect(executions()).toBe(1);
  });

  it("a deterministic 4xx is replayed; a 5xx is NOT (the retry executes again)", async () => {
    const memory = inMemoryStore();
    const { app, runs: executions } = mount(() => [memory]);

    await send(app, "/api/invalida", {}, { "idempotency-key": "val-0000001" });
    const r = await send(app, "/api/invalida", {}, { "idempotency-key": "val-0000001" });
    expect(r.status).toBe(422);
    expect(r.headers.get("idempotent-replayed")).toBe("true");
    expect(executions()).toBe(1);

    await send(app, "/api/falla", {}, { "idempotency-key": "fallo-000001" });
    await send(app, "/api/falla", {}, { "idempotency-key": "fallo-000001" });
    expect(executions()).toBe(3);
    expect(memory.size()).toBe(1); // only the 422
  });
});

describe("same key, another request", () => {
  it("another body → 422 KITSUDEN_E_IDEMPOTENCY_KEY_REUSED in problem+json, without executing", async () => {
    const memory = inMemoryStore();
    const { app, runs: executions } = mount(() => [memory]);
    const h = { "idempotency-key": "op-0002-crear" };
    await send(app, "/api/cosas", { name: "a" }, h);
    const r = await send(app, "/api/cosas", { name: "B" }, h);

    expect(r.status).toBe(422);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    const p = await r.json();
    expect(p.code).toBe("KITSUDEN_E_IDEMPOTENCY_KEY_REUSED");
    expect(p.retryable).toBe(false);
    expect(typeof p.error).toBe("string");
    expect(executions()).toBe(1);
  });

  it("another route with the same key is also reuse", async () => {
    const memory = inMemoryStore();
    const { app } = mount(() => [memory]);
    const h = { "idempotency-key": "op-0003-crear" };
    await send(app, "/api/cosas", { name: "a" }, h);
    const r = await send(app, "/api/invalida", { name: "a" }, h);
    expect((await r.json()).code).toBe("KITSUDEN_E_IDEMPOTENCY_KEY_REUSED");
  });

  it("the same key from ANOTHER actor is another operation (and does not see the other's response)", async () => {
    const memory = inMemoryStore();
    const { app, runs: executions } = mount(() => [memory]);
    const h = { "idempotency-key": "op-compartida-1" };
    const a = await send(app, "/api/cosas", { name: "a" }, { ...h, "x-test-user": "ana" });
    const b = await send(app, "/api/cosas", { name: "a" }, { ...h, "x-test-user": "beto" });
    expect(executions()).toBe(2);
    expect((await a.json()).id).not.toBe((await b.json()).id);
    expect(b.headers.get("idempotent-replayed")).toBeNull();
  });

  it("a malformed key → 422 KITSUDEN_E_IDEMPOTENCY_KEY_INVALID", async () => {
    const { app, runs: executions } = mount(() => [inMemoryStore()]);
    const r = await send(app, "/api/cosas", {}, { "idempotency-key": "x'; DROP--" });
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("KITSUDEN_E_IDEMPOTENCY_KEY_INVALID");
    expect(executions()).toBe(0);
  });
});

describe("concurrencia", () => {
  it("two simultaneous requests with the same key: one executes, the other 409 retryable", async () => {
    const memory = inMemoryStore();
    const { app, runs: executions } = mount(() => [memory]);
    const h = { "idempotency-key": "simultanea-0001" };
    const [a, b] = await Promise.all([
      send(app, "/api/lento", {}, h),
      send(app, "/api/lento", {}, h),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(executions()).toBe(1);
    const conflict = a.status === 409 ? a : b;
    const p = await conflict.json();
    expect(p.code).toBe("KITSUDEN_E_IDEMPOTENCY_IN_PROGRESS");
    expect(p.retryable).toBe(true);
    expect(p.retry_after).toBe(1);
    expect(conflict.headers.get("retry-after")).toBe("1");

    // And on retrying afterwards, it receives the result of the first
    const after = await send(app, "/api/lento", {}, h);
    expect(after.status).toBe(201);
    expect(after.headers.get("idempotent-replayed")).toBe("true");
    expect(executions()).toBe(1);
  });
});

describe("expiry", () => {
  it("after the TTL, the same key executes again", async () => {
    let now = 1_000_000;
    const memory = inMemoryStore(() => now);
    const { app, runs: executions } = mount(() => [memory]);
    const h = { "idempotency-key": "caduca-000001" };

    await send(app, "/api/cosas", { n: 1 }, h);
    now += CONFIG.lifetimeMs - 1;
    await send(app, "/api/cosas", { n: 1 }, h);
    expect(executions()).toBe(1);

    now += 2;
    const r = await send(app, "/api/cosas", { n: 1 }, h);
    expect(executions()).toBe(2);
    expect(r.headers.get("idempotent-replayed")).toBeNull();
  });

  it("the configuration comes from the environment (TTL, lock, failure mode)", () => {
    const c = idempotencyConfig({
      IDEMPOTENCY_TTL_SECONDS: "3600",
      IDEMPOTENCY_LOCK_SECONDS: "30",
      IDEMPOTENCY_FAIL_MODE: "open",
    });
    expect(c).toMatchObject({ lifetimeMs: 3_600_000, blockingMs: 30_000, failureMode: "open" });
    expect(idempotencyConfig({}).failureMode).toBe("closed");
    expect(idempotencyConfig({ IDEMPOTENCY_TTL_SECONDS: "-5" }).lifetimeMs).toBe(86_400_000);
  });
});

describe("secretos", () => {
  it("a response with an agent key is not stored: the retry receives 409 NOT_REPLAYABLE", async () => {
    const memory = inMemoryStore();
    const { app, runs: executions } = mount(() => [memory]);
    const h = { "idempotency-key": "crear-clave-01" };
    const r1 = await send(app, "/api/claves", {}, h);
    const r2 = await send(app, "/api/claves", {}, h);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(409);
    expect((await r2.json()).code).toBe("KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE");
    expect(executions()).toBe(1);
  });

  it("detects secret fields and values at any depth", () => {
    expect(containsSecret({ data: { apiKey: "abc" } })).toBe(true);
    expect(containsSecret({ items: [{ refresh_token: "r" }] })).toBe(true);
    expect(containsSecret({ note: "kitsuden_sk_0123456789abcdef" })).toBe(true);
    expect(containsSecret({ id: "1", name: "token de juego", tokens: 5 })).toBe(false);
    expect(containsSecret({ password: "" })).toBe(false);
  });
});

// ── Valkey down → Postgres → nothing ────────────────────────────────────────

describe("without Valkey", () => {
  let pg: PGlite;
  let query: SqlQuery;

  beforeAll(async () => {
    pg = await PGlite.create();
    query = async (text, parameters) =>
      (await pg.query<Record<string, unknown>>(text, parameters)).rows;
  });
  afterAll(async () => {
    await pg?.close();
  });

  it("falls back to the Postgres table, which creates itself, and replays the same", async () => {
    const table = postgresStore(query);
    const { app, runs: executions } = mount(() => [down("valkey"), table]);
    const h = { "idempotency-key": "respaldo-pg-01" };

    const r1 = await send(app, "/api/cosas", { x: 1 }, h);
    const r2 = await send(app, "/api/cosas", { x: 1 }, h);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(executions()).toBe(1);

    const rows = await query("SELECT idempotency_key AS key, record->>'status' AS status FROM kitsuden_idempotency", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
    // The key is not stored in the clear: it is a sha256 of actor + key
    expect(String(rows[0]!.key)).toMatch(/^[0-9a-f]{64}$/);
    // And nothing from the cookie in what is stored
    const rawValue = await query("SELECT record::text AS r FROM kitsuden_idempotency", []);
    expect(String(rawValue[0]!.r)).not.toContain("sesion=secreta");
  });

  it("the table also stops simultaneous requests", async () => {
    const table = postgresStore(query);
    const { app, runs: executions } = mount(() => [down("valkey"), table]);
    const h = { "idempotency-key": "respaldo-pg-02" };
    const [a, b] = await Promise.all([
      send(app, "/api/lento", {}, h),
      send(app, "/api/lento", {}, h),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(executions()).toBe(1);
  });

  it("an expired reservation in the table can be taken again", async () => {
    const table = postgresStore(query);
    const reg = { status: "in-progress" as const, token: "t1", fingerprint: "h", createdAt: 0 };
    expect((await table.reserve("caducada", reg, 60_000)).reservedValue).toBe(true);
    await query("UPDATE kitsuden_idempotency SET expires_at = now() - interval '1 second' WHERE idempotency_key = 'caducada'", []);
    expect((await table.reserve("caducada", { ...reg, token: "t2" }, 60_000)).reservedValue).toBe(true);
    // completing with the old token does not overwrite the new reservation
    await table.complete("caducada", "t1", { ...reg, token: "t1", status: "no-replay", reason: "secret" }, 60_000);
    const r = await table.reserve("caducada", { ...reg, token: "t3" }, 60_000);
    expect(r.reservedValue).toBe(false);
    if (!r.reservedValue) expect(r.existing.token).toBe("t2");
  });

  it("without Valkey or table: 503 KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE and it is NOT executed (fail-closed)", async () => {
    const { app, runs: executions } = mount(() => [down("valkey"), down("postgres")]);
    const r = await send(app, "/api/cosas", { x: 1 }, { "idempotency-key": "sin-almacen-01" });
    expect(r.status).toBe(503);
    const p = await r.json();
    expect(p.code).toBe("KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE");
    expect(p.retryable).toBe(true);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(executions()).toBe(0);

    // Without the header, the write is not affected
    expect((await send(app, "/api/cosas", { x: 1 })).status).toBe(201);
  });

  it("IDEMPOTENCY_FAIL_MODE=open: it executes without protection and flags it in a header", async () => {
    const { app, runs: executions } = mount(() => [down("valkey"), down("postgres")], {
      ...CONFIG,
      failureMode: "open",
    });
    const r = await send(app, "/api/cosas", { x: 1 }, { "idempotency-key": "sin-almacen-02" });
    expect(r.status).toBe(201);
    expect(r.headers.get("idempotency-status")).toBe("unavailable");
    expect(executions()).toBe(1);
  });
});

// ── Real Valkey (optional) ──────────────────────────────────────────────────

const VALKEY = process.env.KITSUDEN_TEST_VALKEY_URL;

describe.skipIf(!VALKEY)("Valkey store against a real Valkey", () => {
  // `redis` is a dependency of apps/api, not of the root
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- redis client loaded by hand
  let client: any;
  beforeAll(async () => {
    const fromApi = createRequire(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../.kitsuden/apps/api/package.json")
    );
    const { createClient } = fromApi("redis") as {
      createClient: (o: { url?: string }) => { connect(): Promise<unknown>; quit(): Promise<unknown> };
    };
    client = createClient({ url: VALKEY });
    await client.connect();
  });
  afterAll(async () => {
    await client?.quit();
  });

  it("replays, stops simultaneous requests, and the Valkey TTL frees the key", async () => {
    const store = valkeyStore(async () => client as unknown as MinimalValkeyClient);
    const { app, runs: executions } = mount(() => [store], { ...CONFIG, lifetimeMs: 1_000 });
    const key = `valkey-real-${Date.now()}`;
    const h = { "idempotency-key": key };

    const [a, b] = await Promise.all([
      send(app, "/api/lento", {}, h),
      send(app, "/api/lento", {}, h),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const r = await send(app, "/api/lento", {}, h);
    expect(r.headers.get("idempotent-replayed")).toBe("true");
    expect(executions()).toBe(1);

    await new Promise((res) => setTimeout(res, 1_200));
    await send(app, "/api/lento", {}, h);
    expect(executions()).toBe(2);
  });

  it("complete/release only act if the token is still the owner (Lua)", async () => {
    const store = valkeyStore(async () => client as unknown as MinimalValkeyClient);
    const k = `lua-${Date.now()}`;
    const reg = { status: "in-progress" as const, token: "owner", fingerprint: "h", createdAt: 0 };
    expect((await store.reserve(k, reg, 5_000)).reservedValue).toBe(true);
    await store.release(k, "otro");
    const follows = await store.reserve(k, { ...reg, token: "x" }, 5_000);
    expect(follows.reservedValue).toBe(false);
    await store.release(k, "owner");
    expect((await store.reserve(k, { ...reg, token: "nuevo" }, 5_000)).reservedValue).toBe(true);
    await store.release(k, "nuevo");
  });
});

// ── With the REAL kon-ecommerce router ──────────────────────────────────────

describe("kon-ecommerce: the generic idempotency in front of its own", () => {
  let client: PGlite;
  let app: Hono;

  beforeAll(async () => {
    const MIG = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../kons/kon-ecommerce/migrations"
    );
    client = await PGlite.create();
    for (const stmt of readSqlFile(resolve(MIG, "0001_shop.sql"), "0001_shop").statements) {
      await client.exec(stmt);
    }
    await client.exec(readFileSync(resolve(MIG, "0002_secure_orders.sql"), "utf8"));
    // 0008: payment, delivery, discount codes (the order insert writes its columns).
    await client.exec(readFileSync(resolve(MIG, "0008_checkout_delivery_coupons.sql"), "utf8"));
    registerShopPolicies();

    const ctx = createTestKonContext({
      db: { instance: drizzle(client), execute: async () => undefined, tableExists: async () => true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      auth: { requireAuth: (c: any) => c.json({ error: "no session" }, 401) } as any,
      konConfig: { "kon-ecommerce": { shippingFlatCents: 500, pickupNote: "Taller" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    } as any);

    const memory = inMemoryStore();
    app = new Hono();
    app.use("*", httpProblems());
    app.use("/api/*", idempotency({ stores: () => [memory], config: CONFIG }));
    app.onError((err) => {
      if (err instanceof AppError) {
        return Response.json({ error: err.message, details: err.details }, { status: err.status });
      }
      return Response.json({ error: String(err) }, { status: 500 });
    });
    app.route("/api/shop", createShopRouter(ctx));
  });
  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await client.exec(`
      DELETE FROM shop_order_items; DELETE FROM shop_orders;
      DELETE FROM shop_variants; DELETE FROM shop_products;
      INSERT INTO shop_products (id, slug, name, kind, active) VALUES ('p-taza', 'taza', 'Taza', 'physical', true);
      INSERT INTO shop_variants (id, product_id, name, price_cents, stock) VALUES ('v-taza', 'p-taza', 'Grande', 2000, 6);
    `);
  });

  const request = {
    items: [{ variantId: "v-taza", quantity: 2 }],
    customerEmail: "ana@ejemplo.com",
    fulfillmentType: "pickup",
  };
  const requests = async () => (await client.query("SELECT id FROM shop_orders")).rows.length;
  const stock = async () =>
    (await client.query<{ stock: number }>("SELECT stock FROM shop_variants WHERE id = 'v-taza'"))
      .rows[0]!.stock;

  it("the retry does not order or deduct again; the first response is not replayed because it carried the buyer's token", async () => {
    // Since 0008 the 201 carries `accessToken`, the buyer's key to the order. The core never
    // stores a response with a secret, so the retry gets NOT_REPLAYABLE (the order was made; the
    // token is in the confirmation email) instead of a copy of the token.
    const h = { "idempotency-key": "pedido-generico-1" };
    const r1 = await send(app, "/api/shop/orders", request, h);
    const r2 = await send(app, "/api/shop/orders", request, h);
    expect([r1.status, r2.status]).toEqual([201, 409]);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect((await r2.json()).code).toBe("KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE");
    expect((await r1.json()).accessToken).toBeTruthy();
    expect(await requests()).toBe(1);
    expect(await stock()).toBe(4);
  });

  it("simultaneous: one order, the other receives a retryable 409", async () => {
    const h = { "idempotency-key": "pedido-generico-2" };
    const [a, b] = await Promise.all([
      send(app, "/api/shop/orders", request, h),
      send(app, "/api/shop/orders", request, h),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await requests()).toBe(1);
  });

  it("key with odd characters: 422 in problem+json, with `error` for the usual clients", async () => {
    const r = await send(app, "/api/shop/orders", request, { "idempotency-key": "x'; DROP TABLE--" });
    expect(r.status).toBe(422);
    const p = await r.json();
    expect(p.code).toBe("KITSUDEN_E_IDEMPOTENCY_KEY_INVALID");
    expect(p.error).toBeTruthy();
    expect(await requests()).toBe(0);
  });

  it("a sold-out order (business 409) is not stored: with stock replenished, the retry executes", async () => {
    await client.exec("UPDATE shop_variants SET stock = 1 WHERE id = 'v-taza'");
    const h = { "idempotency-key": "pedido-agotado-1" };
    const r1 = await send(app, "/api/shop/orders", request, h);
    expect(r1.status).toBe(409);
    const p = await r1.json();
    expect(p.code).toBe("KITSUDEN_E_CONFLICT");
    expect(p.problems).toBeDefined(); // the kon's own field is still there
    await client.exec("UPDATE shop_variants SET stock = 6 WHERE id = 'v-taza'");
    const r2 = await send(app, "/api/shop/orders", request, h);
    expect(r2.status).toBe(201);
  });
});
