/**
 * kon-koe's test bench
 * ============================================================================
 *
 * The kon's migrations on PGlite as a NON-superuser role, the host's per-request RLS transaction, and
 * doubles for everything outside: the queue (jobs are recorded and `drain()` runs them through the
 * kon's real handlers), sealed secrets, storage, realtime, events and Meta's Graph API.
 * No network, no Docker.
 */

import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

import { createTestKonContext } from "../../../.kitsuden/apps/api/src/lib/test-kon-context";
import { configureQueue, queueHandlers, type QueueJob } from "../../../.kitsuden/packages/engine/src/queue";
import { rlsHost } from "../../../.kitsuden/tests/unit/helpers/rls-host";
import { setGraphFetch, sign } from "../../../kons/kon-koe/channels/graph";
import { createKonKoe, registerKoeQueues } from "../../../kons/kon-koe";
import { registerKoePolicy } from "../../../kons/kon-koe/koe.policy";

import { APP_ROLE, dropToAppRole, migratedBase, requestAs, testAuth } from "./safe-kons-bench";

export const APP_SECRET = "test-app-secret-0123456789";
export const KON = "kon-koe";

export interface GraphCall {
  method: string;
  url: string;
  body: unknown;
}

export async function koeBench(extra: Record<string, unknown> = {}) {
  const migrations = readdirSync(resolve(__dirname, `../../../kons/${KON}/migrations`))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const client: PGlite = await migratedBase(KON, migrations);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);

  const jobs: Array<{ queue: string; name: string; payload: unknown; attempts: number }> = [];
  configureQueue({
    dispatch: async (queue, name, payload, options) => {
      jobs.push({ queue, name, payload, attempts: options.attempts ?? 3 });
      return { id: `q-${jobs.length}` };
    },
  });

  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const listeners = new Map<string, Array<(d: unknown) => void>>();
  const broadcasts: Array<{ channel: string; message: Record<string, unknown> }> = [];
  let authorizer: ((rest: string, user: { id: string | null; role: string | null }) => boolean | Promise<boolean>) | null = null;
  const files = new Map<string, Buffer>();
  const opened: string[] = [];

  const ctx = createTestKonContext({
    db: host.db as never,
    auth: auth as never,
    events: {
      emit: (name: string, data: unknown) => {
        events.push({ name, data: data as Record<string, unknown> });
        for (const fn of listeners.get(name) ?? []) fn(data);
      },
      on: (name: string, fn: (d: unknown) => void) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    },
    realtime: {
      broadcast: (channel: string, message: Record<string, unknown>) => broadcasts.push({ channel, message }),
      sendToUser: () => {},
      channels: (fn: typeof authorizer) => {
        authorizer = fn;
      },
      // The host's konCapability: keyed by a secret the kon's tables never hold.
      capability: (material: string) => createHmac("sha256", "test-capability-key").update(`koe:${material}`).digest("hex"),
    },
    secrets: {
      seal: (konId: string, plaintext: string) => ({ v: 1, kon: konId, valueEncrypted: Buffer.from(plaintext).toString("base64"), iv: "x", authTag: "x" }),
      open: async (konId: string, sealed: { kon: string; valueEncrypted: string }, access: { purpose: string }) => {
        if (sealed.kon !== konId) throw new Error("sealed for another kon");
        opened.push(access.purpose);
        return Buffer.from(sealed.valueEncrypted, "base64").toString();
      },
    },
    storage: {
      put: async (key: string, data: Buffer) => {
        files.set(key, Buffer.from(data));
        return { key, url: `https://files.test/${key}` };
      },
      get: async (key: string) => files.get(key) ?? null,
      delete: async (key: string) => void files.delete(key),
      list: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
      publicUrl: (key: string) => `https://files.test/${key}`,
      getSignedDownloadUrl: async (key: string) => `https://files.test/${key}?signed=1`,
      getSignedUploadUrl: async (key: string) => `https://files.test/${key}?upload=1`,
    },
    config: { siteName: "Test", siteUrl: "https://koe.test", environment: "test" },
    ...extra,
  } as never);

  registerKoePolicy();
  const app = host.mount(createKonKoe(ctx));
  const request = requestAs(app);
  registerKoeQueues(ctx);
  // The realtime authorizer is registered by onStartup in the host.
  (await import("../../../kons/kon-koe/koe.realtime")).registerRealtime(ctx);

  // ── Graph API double ──────────────────────────────────────────────────
  const graphCalls: GraphCall[] = [];
  let ids = 0;
  let graphResponder: (call: GraphCall) => { status?: number; body: unknown } = (call) => {
    if (call.url.includes("/messages")) return { body: { messages: [{ id: `wamid.out${++ids}` }] } };
    if (call.url.includes("/media")) return { body: { id: `media-${++ids}` } };
    return { body: {} };
  };
  setGraphFetch(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep */
      }
    }
    const call = { method: String(init?.method ?? "GET"), url, body };
    graphCalls.push(call);
    const r = graphResponder(call);
    if (r.body instanceof Buffer) return new Response(new Uint8Array(r.body), { status: r.status ?? 200, headers: { "content-type": "audio/ogg" } });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });

  /** Runs every queued job through koe's real handlers, until none is left. Throws what a handler throws. */
  async function drain(max = 200): Promise<Array<{ queue: string; name: string }>> {
    const ran: Array<{ queue: string; name: string }> = [];
    for (let i = 0; i < max && jobs.length; i++) {
      const j = jobs.shift()!;
      const handler = queueHandlers().get(j.queue);
      if (!handler) continue;
      const job: QueueJob = { id: `job-${i}`, queue: j.queue, name: j.name, payload: j.payload, attempt: 1, maxAttempts: 1, actor: null, requestId: null };
      await handler.fn(job);
      ran.push({ queue: j.queue, name: j.name });
    }
    return ran;
  }

  /** Raw rows as the superuser that migrated, to look past RLS. */
  async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await client.exec("RESET ROLE");
    try {
      return (await client.query<T>(sql, params)).rows;
    } finally {
      await client.exec(`SET ROLE ${APP_ROLE}`);
    }
  }

  /** POSTs a signed Meta webhook. */
  function webhook(body: unknown, secret = APP_SECRET) {
    const raw = JSON.stringify(body);
    return request("anon", "POST", "/webhooks/meta", raw, { "x-hub-signature-256": sign(raw, secret), "content-type": "application/json" });
  }

  return {
    client,
    ctx,
    request,
    jobs,
    events,
    broadcasts,
    files,
    opened,
    graphCalls,
    authorize: (rest: string, user: { id: string | null; role: string | null }) => (authorizer ? authorizer(rest, user) : false),
    respondGraph(fn: typeof graphResponder) {
      graphResponder = fn;
    },
    drain,
    rows,
    webhook,
    async close() {
      configureQueue(null);
      setGraphFetch(null);
      await client.close();
    },
  };
}

/** A WhatsApp `messages` webhook body. */
export function waBody(phoneNumberId: string, opts: { messages?: unknown[]; statuses?: unknown[]; contacts?: unknown[]; wabaId?: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: opts.wabaId ?? "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "51900000000", phone_number_id: phoneNumberId },
              ...(opts.contacts ? { contacts: opts.contacts } : {}),
              ...(opts.messages ? { messages: opts.messages } : {}),
              ...(opts.statuses ? { statuses: opts.statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

export const waText = (from: string, id: string, text: string, ts = Math.floor(Date.now() / 1000)) => ({ from, id, timestamp: String(ts), type: "text", text: { body: text } });
