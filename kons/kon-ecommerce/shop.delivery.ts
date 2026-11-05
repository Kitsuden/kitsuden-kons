/**
 * Delivering what a digital purchase bought
 * ============================================================================
 *
 * When an order is paid, each digital line gets its ENTITLEMENTS: one per file the product (or
 * that variant of it) delivers, and one license key per unit when the variant gives keys. The
 * buyer reaches them with the order token (shop.access.ts); a refund revokes them.
 *
 * ── WHY GRANTING CAN RUN TWICE ─────────────────────────────────────────────
 *
 * Payment providers retry webhooks, the team can mark an order paid by hand, and a variant in
 * `pool` mode can run out of keys. So granting is a "fill in what is missing" step: it adds the
 * files and keys a line does not have yet and leaves the rest. Running it again after uploading
 * keys delivers the ones that were short, and never hands out a second copy.
 *
 * ── DOWNLOADS ──────────────────────────────────────────────────────────────
 *
 * A download is counted with a conditional UPDATE (same trick as the stock): with a limit of 5,
 * five requests at once cannot become six downloads. The file is served through a storage URL
 * signed for five minutes, never a permanent link that could be shared.
 */

import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Executor } from "./shop.orders";

function rows<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Without 0/O and 1/I/L: a key read aloud or copied by hand must not be misread. */
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A license key like `K7M2P-QX9RT-…`: five groups of five, 125 random bits or so. */
export function generateLicenseKey(): string {
  const bytes = randomBytes(25);
  const chars = [...bytes].map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length]);
  return [0, 5, 10, 15, 20].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

export interface DeliveryResult {
  /** Entitlements created by THIS call (0 on a repeat). */
  granted: number;
  /** Keys a `pool` variant could not supply: the team has to upload more and deliver again. */
  keysMissing: number;
}

interface DigitalLine {
  id: string;
  variantId: string | null;
  quantity: number;
  productId: string | null;
  licenseMode: string | null;
  downloadLimit: number | null;
  downloadDays: number | null;
}

/**
 * Gives a paid order's digital lines what they bought, filling in only what is missing.
 * Run it inside the transaction that marks the order paid.
 */
export async function grantEntitlements(
  db: Executor,
  orderId: string,
  now: Date = new Date()
): Promise<DeliveryResult> {
  const lines = rows<DigitalLine>(
    await db.execute(sql`
      SELECT i.id, i.variant_id AS "variantId", i.quantity, v.product_id AS "productId",
             v.license_mode AS "licenseMode", v.download_limit AS "downloadLimit",
             v.download_days AS "downloadDays"
      FROM shop_order_items i
      LEFT JOIN shop_variants v ON v.id = i.variant_id
      WHERE i.order_id = ${orderId} AND i.kind = 'digital'
    `)
  );

  let granted = 0;
  let keysMissing = 0;

  for (const line of lines) {
    // A line whose variant was deleted keeps its history but has nothing left to deliver.
    if (!line.variantId || !line.productId) continue;

    const expiresAt = line.downloadDays
      ? new Date(now.getTime() + Number(line.downloadDays) * 86_400_000).toISOString()
      : null;

    // ── Files: one entitlement per file the line does not have yet ──
    const created = await db.execute(sql`
      INSERT INTO shop_entitlements
        (id, order_id, order_item_id, kind, file_id, filename, download_limit, expires_at)
      SELECT gen_random_uuid()::text, ${orderId}, ${line.id}, 'download', f.id, f.filename,
             ${line.downloadLimit}, ${expiresAt}::timestamptz
      FROM shop_product_files f
      WHERE f.product_id = ${line.productId}
        AND (f.variant_id IS NULL OR f.variant_id = ${line.variantId})
        AND NOT EXISTS (
          SELECT 1 FROM shop_entitlements e
          WHERE e.order_item_id = ${line.id} AND e.file_id = f.id
        )
      RETURNING id
    `);
    granted += rows(created).length;

    // ── License keys: one per unit ──
    if (line.licenseMode !== "generate" && line.licenseMode !== "pool") continue;
    const had = rows<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM shop_entitlements
        WHERE order_item_id = ${line.id} AND kind = 'license'
      `)
    )[0];
    const missing = Number(line.quantity) - Number(had?.n ?? 0);
    if (missing <= 0) continue;

    let keys: string[];
    if (line.licenseMode === "generate") {
      keys = Array.from({ length: missing }, generateLicenseKey);
    } else {
      // SKIP LOCKED: two orders paid at once take different keys instead of waiting for each
      // other, and a key is never given to both.
      keys = rows<{ licenseKey: string }>(
        await db.execute(sql`
          UPDATE shop_license_keys
          SET order_item_id = ${line.id}, assigned_at = ${now.toISOString()}::timestamptz
          WHERE id IN (
            SELECT id FROM shop_license_keys
            WHERE variant_id = ${line.variantId} AND order_item_id IS NULL
            ORDER BY created_at, id
            LIMIT ${missing}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING license_key AS "licenseKey"
        `)
      ).map((r) => r.licenseKey);
      keysMissing += missing - keys.length;
    }

    for (const key of keys) {
      await db.execute(sql`
        INSERT INTO shop_entitlements (id, order_id, order_item_id, kind, license_key)
        VALUES (gen_random_uuid()::text, ${orderId}, ${line.id}, 'license', ${key})
      `);
      granted++;
    }
  }

  return { granted, keysMissing };
}

/** A refund takes back what was delivered. The rows stay, marked, as the record. */
export async function revokeEntitlements(
  db: Executor,
  orderId: string,
  now = new Date()
): Promise<number> {
  const res = await db.execute(sql`
    UPDATE shop_entitlements SET revoked_at = ${now.toISOString()}::timestamptz
    WHERE order_id = ${orderId} AND revoked_at IS NULL
    RETURNING id
  `);
  return rows(res).length;
}

/** What the buyer sees of their entitlements. Revoked ones are listed as revoked, without the key. */
export interface EntitlementView {
  id: string;
  kind: "download" | "license";
  filename: string | null;
  licenseKey: string | null;
  downloadsUsed: number;
  downloadLimit: number | null;
  expiresAt: string | null;
  revoked: boolean;
}

export async function entitlementsOf(db: Executor, orderId: string): Promise<EntitlementView[]> {
  const list = rows<{
    id: string;
    kind: "download" | "license";
    filename: string | null;
    licenseKey: string | null;
    downloadsUsed: number;
    downloadLimit: number | null;
    expiresAt: string | Date | null;
    revokedAt: string | Date | null;
  }>(
    await db.execute(sql`
      SELECT id, kind, filename, license_key AS "licenseKey", downloads_used AS "downloadsUsed",
             download_limit AS "downloadLimit", expires_at AS "expiresAt", revoked_at AS "revokedAt"
      FROM shop_entitlements WHERE order_id = ${orderId}
      ORDER BY kind, created_at, id
    `)
  );
  return list.map((e) => ({
    id: e.id,
    kind: e.kind,
    filename: e.filename,
    licenseKey: e.revokedAt ? null : e.licenseKey,
    downloadsUsed: Number(e.downloadsUsed),
    downloadLimit: e.downloadLimit === null ? null : Number(e.downloadLimit),
    expiresAt: e.expiresAt === null ? null : new Date(e.expiresAt).toISOString(),
    revoked: e.revokedAt !== null,
  }));
}

export type DownloadAnswer =
  | { ok: true; storageKey: string; filename: string | null }
  | { ok: false; reason: "not-found" | "revoked" | "expired" | "limit" };

/**
 * Counts one download of an entitlement of THIS order and returns the storage key to sign.
 * The caller has already checked the order token.
 */
export async function takeDownload(
  db: Executor,
  orderId: string,
  entitlementId: string,
  now = new Date()
): Promise<DownloadAnswer> {
  const found = rows<{
    storageKey: string | null;
    filename: string | null;
    revokedAt: unknown;
    expiresAt: string | Date | null;
    downloadsUsed: number;
    downloadLimit: number | null;
  }>(
    await db.execute(sql`
      SELECT m.key AS "storageKey", e.filename, e.revoked_at AS "revokedAt",
             e.expires_at AS "expiresAt", e.downloads_used AS "downloadsUsed",
             e.download_limit AS "downloadLimit"
      FROM shop_entitlements e
      LEFT JOIN shop_product_files f ON f.id = e.file_id
      LEFT JOIN media m ON m.id::text = f.media_id
      WHERE e.id = ${entitlementId} AND e.order_id = ${orderId} AND e.kind = 'download'
      LIMIT 1
    `)
  )[0];

  if (!found || !found.storageKey) return { ok: false, reason: "not-found" };
  if (found.revokedAt) return { ok: false, reason: "revoked" };
  if (found.expiresAt && new Date(found.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  // The count travels INSIDE the UPDATE: five requests at once with one download left give one.
  const counted = await db.execute(sql`
    UPDATE shop_entitlements SET downloads_used = downloads_used + 1
    WHERE id = ${entitlementId} AND order_id = ${orderId} AND revoked_at IS NULL
      AND (download_limit IS NULL OR downloads_used < download_limit)
    RETURNING id
  `);
  if (rows(counted).length === 0) return { ok: false, reason: "limit" };

  return { ok: true, storageKey: found.storageKey, filename: found.filename };
}
