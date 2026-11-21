/**
 * Odoo — the queues and the schedules
 * ============================================================================
 *
 *   kon-odoo-sync   Odoo → mirror     templates, variants, categories, full, orders, payments, image
 *   kon-odoo-push   Kitsuden → out    order (to Odoo), provision (to Odoo), purge (to the site)
 *
 * A job runs inside one transaction: if it throws, what it wrote is undone and the queue tries
 * again later. So a job that has to RECORD a failure (a run that cannot go on, an order Odoo
 * refused) writes that and returns; it does not throw.
 *
 * What is not worth retrying is thrown as `PermanentError`: Odoo is not connected, the key was
 * refused, or Odoo answered "no" for a reason that will be the same next time.
 */

import { PermanentError, queue, type QueueJob } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { lt } from "drizzle-orm";

import { OdooError } from "./odoo.client";
import { odooLocation, OdooNotConnected } from "./odoo.connection";
import { cancelInOdoo, expireUnpaid, forgetCarts, settleOrder } from "./odoo.checkout";
import { announcePayments, provisionProduct, pushOrder, refreshOrders, type ProvisionRequest } from "./odoo.orders";
import { odooNotices } from "./odoo.schema";
import { clientFor, dbOf, loadSettings, QUEUES } from "./odoo.state";
import {
  failRun,
  fullSyncPage,
  startFullSync,
  syncCategories,
  syncImage,
  syncTemplates,
  templatesOfVariants,
} from "./odoo.sync";
import { sendPurge } from "./odoo.webhook";

/** Why a job cannot succeed however often it is tried, or null when trying again may help. */
function hopeless(error: unknown): string | null {
  if (error instanceof OdooNotConnected) return error.message;
  if (error instanceof OdooError && !error.retryable) return `Odoo: ${error.message}`;
  return null;
}

async function settled<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const reason = hopeless(error);
    if (reason) throw new PermanentError(reason);
    throw error;
  }
}

const baseUrl = (): string | null => {
  const location = odooLocation();
  return "problem" in location ? null : location.baseUrl;
};

async function runSync(ctx: KonContext, job: QueueJob): Promise<void> {
  const ids = ((job.payload as { ids?: number[] } | null)?.ids ?? []).filter((id) => Number.isInteger(id));

  switch (job.name) {
    case "templates":
      await syncTemplates(ctx, await clientFor(ctx, "read changed products from Odoo"), ids);
      return;
    case "variants": {
      const client = await clientFor(ctx, "read changed stock and variants from Odoo");
      await syncTemplates(ctx, client, await templatesOfVariants(ctx, client, ids));
      return;
    }
    case "categories":
      await syncCategories(ctx, await clientFor(ctx, "read product categories from Odoo"));
      return;
    case "orders":
      await refreshOrders(ctx, await clientFor(ctx, "read changed sales orders from Odoo"), ids, baseUrl());
      return;
    case "payments":
      await announcePayments(ctx, await clientFor(ctx, "read customer payments from Odoo"), ids);
      return;
    case "image": {
      const odooId = (job.payload as { odooId?: number } | null)?.odooId;
      if (Number.isInteger(odooId)) {
        await syncImage(ctx, await clientFor(ctx, "copy a product image from Odoo"), odooId as number);
      }
      return;
    }
    case "full": {
      const page = job.payload as { runId: string; after: number };
      try {
        await fullSyncPage(ctx, await clientFor(ctx, "walk the whole catalog in Odoo"), page);
      } catch (error) {
        const reason = hopeless(error);
        // Out of attempts, or pointless to retry: the run is closed with the reason, and that
        // has to be committed, so this job ends well.
        if (reason || job.attempt >= job.maxAttempts) {
          await failRun(ctx, page.runId, reason ?? (error instanceof Error ? error.message : String(error)));
          return;
        }
        throw error;
      }
      return;
    }
    default:
      throw new PermanentError(`kon-odoo: unknown sync job "${job.name}"`);
  }
}

async function runPush(ctx: KonContext, job: QueueJob): Promise<void> {
  switch (job.name) {
    case "order":
      await pushOrder(
        ctx,
        await clientFor(ctx, "create a sales order in Odoo"),
        job.payload as { orderId: string; confirm?: boolean },
        baseUrl()
      );
      return;
    case "provision": {
      const client = await clientFor(ctx, "create a product in Odoo");
      const template = await provisionProduct(client, job.payload as ProvisionRequest);
      await syncTemplates(ctx, client, [template]);
      return;
    }
    case "settle":
      await settleOrder(
        ctx,
        await clientFor(ctx, "confirm a paid sales order in Odoo"),
        (job.payload as { orderId: string }).orderId,
        baseUrl()
      );
      return;
    case "cancel":
      await cancelInOdoo(ctx, await clientFor(ctx, "cancel an expired quotation in Odoo"), (job.payload as { orderId: string }).orderId);
      return;
    case "purge":
      await sendPurge(ctx, (job.payload as { ids?: number[] } | null)?.ids ?? []);
      return;
    default:
      throw new PermanentError(`kon-odoo: unknown push job "${job.name}"`);
  }
}

/** Queue handlers; registered at startup and by the tests. */
export function registerOdooQueues(ctx: KonContext): void {
  // Two at a time towards Odoo: enough to keep up with a busy shop, not enough to load an ERP
  // that people are also working in.
  queue.handle(QUEUES.sync, (job) => settled(() => runSync(ctx, job)), { concurrency: 2 });
  queue.handle(QUEUES.push, (job) => settled(() => runPush(ctx, job)), { concurrency: 2 });
}

/** Days before the key's last day when someone starts being told. */
export const KEY_WARNING_DAYS = 14;

/** Change notices are kept this long: enough to recognise a late retry, no longer. */
const NOTICE_DAYS = 30;

export function daysUntil(day: string, now: Date): number {
  const end = Date.parse(`${day}T00:00:00Z`);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end - start) / 86_400_000);
}

/**
 * The shape of the host's `KonSchedule` (Kitsuden with kon schedules), written here so the kon
 * still builds against a host without them. There the schedules are simply not run: the nightly
 * walk is then `start-sync`, by hand or from an automation rule.
 */
export interface OdooSchedule {
  id: string;
  cron: string;
  description?: string;
  run(ctx: KonContext, tick: { scheduledAt: Date }): Promise<void>;
}

export const odooSchedules: OdooSchedule[] = [
  {
    id: "reconcile",
    // Before the shop opens. A notice that never arrived is caught here, a night late at most.
    cron: "15 3 * * *",
    description: "Walk the whole Odoo catalog and put the mirror in step.",
    run: async (ctx) => {
      await startFullSync(ctx);
    },
  },
  {
    id: "expire-holds",
    cron: "* * * * *",
    description: "Expire unpaid orders whose held units ran out, and put the units back on sale.",
    run: async (ctx, tick) => {
      await expireUnpaid(ctx, tick.scheduledAt);
    },
  },
  {
    id: "housekeeping",
    cron: "40 7 * * *",
    description: "Warn when the Odoo API key is about to expire; forget old change notices and abandoned carts.",
    run: async (ctx, tick) => {
      const db = dbOf(ctx);
      const settings = await loadSettings(db);
      if (settings.keyExpiresOn) {
        const daysLeft = daysUntil(settings.keyExpiresOn, tick.scheduledAt);
        if (daysLeft <= KEY_WARNING_DAYS) {
          ctx.logger.warn("kon-odoo: the Odoo API key expires soon", { expiresOn: settings.keyExpiresOn, daysLeft });
          ctx.events.emit("odoo:key.expiring", { expiresOn: settings.keyExpiresOn, daysLeft });
        }
      }
      const before = new Date(tick.scheduledAt.getTime() - NOTICE_DAYS * 86_400_000);
      await db.delete(odooNotices).where(lt(odooNotices.receivedAt, before));
      await forgetCarts(ctx, tick.scheduledAt);
    },
  },
];
