/**
 * How a buyer without an account reaches THEIR order
 * ============================================================================
 *
 * The buyer is not a system user (see shop.policy.ts), so the panel's policy never opens an order
 * to them. Two tokens do, each checked here and nowhere else:
 *
 *   · the ORDER token — random, given once in the response to `POST /orders` and in the
 *     confirmation email. It opens that one order: pay it, see it, download what it bought.
 *   · a "MY ORDERS" token — asked for with an email, sent only to that email, valid for a short
 *     while. It opens every order placed with that email.
 *
 * Only their sha256 is stored, like a password: a copy of the database does not hand out
 * anyone's downloads. Comparisons go through the hash, so their time says nothing about the token.
 */

import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Executor } from "./shop.orders";

/** 32 random bytes: not guessable, and short enough for a link. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A token has this shape or it is not one; anything else is refused before touching the database. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,100}$/;

/** Minutes a "my orders" link works. */
export const LINK_MINUTES = 30;
/** One link per email in this window: asking again sends nothing (and answers the same). */
export const LINK_THROTTLE_MINUTES = 2;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function rows<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as T[];
}

/**
 * The email a live "my orders" token belongs to, or `null`.
 */
export async function emailOfLink(
  db: Executor,
  token: string,
  now = new Date()
): Promise<string | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const res = await db.execute(sql`
    SELECT email FROM shop_order_links
    WHERE token_hash = ${hashToken(token)} AND expires_at > ${now.toISOString()}::timestamptz
    LIMIT 1
  `);
  return rows<{ email: string }>(res)[0]?.email ?? null;
}

/** Days the link inside a status email works: it is read later than a link one asked for. */
export const STATUS_LINK_DAYS = 7;

/**
 * Creates a "my orders" link for this email, or `null` if one was made a moment ago.
 *
 * `null` and a token must look the same from outside (the route answers 202 either way): the
 * difference would tell anyone which emails have bought here.
 *
 * `{ throttle: false, minutes }` is for the shop's own emails (paid, shipped…), which carry a
 * link the buyer may open days later; it only ever goes to the order's own email.
 */
export async function issueLink(
  db: Executor,
  email: string,
  now = new Date(),
  options: { throttle?: boolean; minutes?: number } = {}
): Promise<string | null> {
  const who = normalizeEmail(email);
  if (options.throttle !== false) {
    const since = new Date(now.getTime() - LINK_THROTTLE_MINUTES * 60_000).toISOString();
    const recent = await db.execute(sql`
      SELECT 1 FROM shop_order_links WHERE email = ${who} AND created_at > ${since}::timestamptz LIMIT 1
    `);
    if (rows(recent).length > 0) return null;
  }

  // Old links of anyone are swept on the way: the table only holds live ones.
  await db.execute(
    sql`DELETE FROM shop_order_links WHERE expires_at < ${now.toISOString()}::timestamptz`
  );

  const token = newToken();
  const expires = new Date(
    now.getTime() + (options.minutes ?? LINK_MINUTES) * 60_000
  ).toISOString();
  await db.execute(sql`
    INSERT INTO shop_order_links (token_hash, email, expires_at, created_at)
    VALUES (${hashToken(token)}, ${who}, ${expires}::timestamptz, ${now.toISOString()}::timestamptz)
  `);
  return token;
}

/** The parts of an order that decide who may open it. */
export interface OrderKey {
  id: string;
  customerEmail: string;
  accessTokenHash: string | null;
}

/**
 * Does this token open this order? Either it is the order's own token, or a live "my orders"
 * token of the same email.
 */
export async function tokenOpensOrder(
  db: Executor,
  order: OrderKey,
  token: string | undefined,
  now = new Date()
): Promise<boolean> {
  if (!token || !TOKEN_SHAPE.test(token)) return false;
  if (order.accessTokenHash && order.accessTokenHash === hashToken(token)) return true;
  const email = await emailOfLink(db, token, now);
  return email !== null && email === normalizeEmail(order.customerEmail);
}
