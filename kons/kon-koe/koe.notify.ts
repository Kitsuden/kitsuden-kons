/**
 * Telling people: notices, the live inbox and web push
 * ============================================================================
 *
 * A notice (`koe_notices`) is the durable record: "a message in your conversation", "a conversation waits
 * in your team's queue", "you were mentioned", "the window closes in 2 hours", "a channel broke". It is sent
 * live to the person's realtime channel, and, when they have not been seen in the inbox for a minute, as a
 * web push.
 *
 * Web push carries NO payload: the push is a signed, empty "tickle" (VAPID, RFC 8292) and the service worker
 * asks `GET /notices/latest` with the person's session for what to show. Nothing about a conversation passes
 * through the push service, and there is no payload encryption to get wrong. The VAPID key pair is created
 * on first use; its private half is sealed with ctx.secrets.
 *
 * Subscriptions go only to the browsers' own push services (the hosts below), never to an arbitrary URL.
 */

import { createPrivateKey, generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto";

import { asSystem, PermanentError, type QueueJob } from "@kitsuden/engine";
import type { KonContext, SealedSecret } from "@kitsuden/shared";
import { and, eq, inArray, lt, or, isNull } from "drizzle-orm";

import { dbOf, KON_ID, newId, type Db } from "./koe.common";
import { toUser } from "./koe.realtime";
import { koeConfig, koeConversations, koeContacts, koeMembers, koeNotices, koePushSubscriptions, koeTeamMembers } from "./koe.schema";

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];

export function isPushEndpoint(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

const b64url = (b: Buffer) => b.toString("base64url");

interface Vapid {
  publicKey: string;
  privateKey: KeyObject;
}
let cached: Vapid | null = null;

/** The installation's VAPID keys, created and sealed the first time. */
export async function vapidKeys(ctx: KonContext, db: Db): Promise<Vapid | null> {
  if (cached) return cached;
  if (!ctx.secrets) return null;
  return asSystem(async () => {
    const [row] = (await db.select().from(koeConfig).where(eq(koeConfig.key, "vapid")).limit(1)) as Array<typeof koeConfig.$inferSelect>;
    if (row?.privateSecret) {
      const pem = await ctx.secrets!.open(KON_ID, row.privateSecret as SealedSecret, { purpose: "web-push", subject: "vapid" });
      cached = { publicKey: String(row.value.publicKey), privateKey: createPrivateKey(pem) };
      return cached;
    }
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    // Uncompressed point: 0x04 || X || Y, what PushManager.subscribe() expects as applicationServerKey.
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    const pub = b64url(raw);
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await db
      .insert(koeConfig)
      .values({ key: "vapid", value: { publicKey: pub }, privateSecret: ctx.secrets!.seal(KON_ID, pem) })
      .onConflictDoNothing();
    // Another process may have won the race: read what is stored.
    const [stored] = (await db.select().from(koeConfig).where(eq(koeConfig.key, "vapid")).limit(1)) as Array<typeof koeConfig.$inferSelect>;
    const storedPem = await ctx.secrets!.open(KON_ID, stored!.privateSecret as SealedSecret, { purpose: "web-push", subject: "vapid" });
    cached = { publicKey: String(stored!.value.publicKey), privateKey: createPrivateKey(storedPem) };
    return cached;
  });
}

/** For tests. */
export function forgetVapid(): void {
  cached = null;
}

export function vapidJwt(endpoint: string, keys: Vapid, subject: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = signData("sha256", Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(signature)}`;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let pushFetch: Fetch = (...a) => fetch(...a);
export function setPushFetch(f: Fetch | null): void {
  pushFetch = f ?? ((...a) => fetch(...a));
}

/** Sends an empty push to every browser of this person. Dead subscriptions are removed. */
export async function push(ctx: KonContext, db: Db, userId: string): Promise<number> {
  const keys = await vapidKeys(ctx, db);
  if (!keys) return 0;
  const subs = (await asSystem(() => db.select().from(koePushSubscriptions).where(eq(koePushSubscriptions.userId, userId)))) as Array<typeof koePushSubscriptions.$inferSelect>;
  let sent = 0;
  const subject = ctx.config?.siteUrl?.startsWith("https://") ? ctx.config.siteUrl : "mailto:koe@localhost";
  for (const s of subs) {
    if (!isPushEndpoint(s.endpoint)) continue;
    try {
      const res = await pushFetch(s.endpoint, {
        method: "POST",
        headers: { TTL: "300", Urgency: "high", "Content-Length": "0", Authorization: `vapid t=${vapidJwt(s.endpoint, keys, subject)}, k=${keys.publicKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404 || res.status === 410) {
        await asSystem(() => db.delete(koePushSubscriptions).where(eq(koePushSubscriptions.id, s.id)));
      } else if (res.ok) {
        sent++;
        await asSystem(() => db.update(koePushSubscriptions).set({ lastUsedAt: new Date() }).where(eq(koePushSubscriptions.id, s.id)));
      }
    } catch (err) {
      ctx.logger.warn("koe: web push failed", { error: err instanceof Error ? err.name : "error" });
    }
  }
  return sent;
}

/** Seen in the inbox in the last minute: the live channel is enough, no push. */
async function isActive(db: Db, userId: string): Promise<boolean> {
  const [m] = (await db.select({ lastSeenAt: koeMembers.lastSeenAt }).from(koeMembers).where(eq(koeMembers.userId, userId)).limit(1)) as Array<{ lastSeenAt: Date | null }>;
  return !!m?.lastSeenAt && Date.now() - new Date(m.lastSeenAt).getTime() < 60_000;
}

export async function notice(
  ctx: KonContext,
  db: Db,
  userIds: string[],
  n: { kind: string; title: string; body?: string | null; conversationId?: string | null }
): Promise<void> {
  for (const userId of [...new Set(userIds)]) {
    const id = newId();
    await asSystem(() =>
      db.insert(koeNotices).values({ id, userId, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 500) ?? null, conversationId: n.conversationId ?? null })
    );
    toUser(ctx, userId, { type: "notice", id, kind: n.kind, title: n.title, conversationId: n.conversationId ?? null });
    if (!(await isActive(db, userId))) await push(ctx, db, userId);
  }
}

/** Admins and supervisors (channel problems, quality drops). */
export async function leadsOf(db: Db): Promise<string[]> {
  const rows = (await asSystem(() => db.select({ id: koeMembers.userId }).from(koeMembers).where(inArray(koeMembers.role, ["admin", "supervisor"])))) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

async function nameOf(db: Db, conversationId: string): Promise<string> {
  const [row] = (await db
    .select({ name: koeContacts.displayName, phone: koeContacts.phone })
    .from(koeConversations)
    .innerJoin(koeContacts, eq(koeContacts.id, koeConversations.contactId))
    .where(eq(koeConversations.id, conversationId))
    .limit(1)) as Array<{ name: string | null; phone: string | null }>;
  return row?.name ?? row?.phone ?? "A contact";
}

/** The `koe-notify` queue. */
export async function processNotify(ctx: KonContext, job: QueueJob<Record<string, string | null | undefined>>): Promise<void> {
  const p = job.payload ?? {};
  const db = dbOf(ctx);
  await asSystem(async () => {
    switch (job.name) {
      case "message": {
        if (!p.userId || !p.conversationId) throw new PermanentError("message notice without user or conversation");
        await notice(ctx, db, [p.userId], { kind: "message", title: `New message from ${await nameOf(db, p.conversationId)}`, conversationId: p.conversationId });
        return;
      }
      case "queued": {
        if (!p.conversationId) throw new PermanentError("queued notice without conversation");
        const users = p.teamId
          ? ((await db
              .select({ id: koeTeamMembers.userId })
              .from(koeTeamMembers)
              .innerJoin(koeMembers, eq(koeMembers.userId, koeTeamMembers.userId))
              .where(and(eq(koeTeamMembers.teamId, p.teamId), eq(koeMembers.available, true)))) as Array<{ id: string }>).map((r) => r.id)
          : await leadsOf(db);
        await notice(ctx, db, users, { kind: "queued", title: `${await nameOf(db, p.conversationId)} is waiting for a person`, conversationId: p.conversationId });
        return;
      }
      case "mention": {
        if (!p.userId || !p.conversationId) throw new PermanentError("mention without user");
        await notice(ctx, db, [p.userId], { kind: "mention", title: `${p.by ?? "Someone"} mentioned you`, body: p.body ?? null, conversationId: p.conversationId });
        return;
      }
      case "leads": {
        await notice(ctx, db, await leadsOf(db), { kind: p.kind ?? "channel", title: p.title ?? "koe needs attention", body: p.body ?? null, conversationId: p.conversationId ?? null });
        return;
      }
      case "user": {
        if (!p.userId) throw new PermanentError("notice without user");
        await notice(ctx, db, [p.userId], { kind: p.kind ?? "info", title: p.title ?? "koe", body: p.body ?? null, conversationId: p.conversationId ?? null });
        return;
      }
      default:
        throw new PermanentError(`unknown notice ${job.name}`);
    }
  });
}

/** Old notices go after 30 days (called by the sweep). */
export async function pruneNotices(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3_600_000);
  await asSystem(() => db.delete(koeNotices).where(or(lt(koeNotices.createdAt, cutoff), and(isNull(koeNotices.conversationId), lt(koeNotices.createdAt, cutoff)))));
}
