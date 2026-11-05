/**
 * Kitsuden Newsletter — Kon
 * ============================================================================
 *
 * What Ghost does (members, tiers, segmentation, campaigns, metrics)
 * delegating the delivery, exactly as Ghost delegates to Mailgun.
 *
 * HOW IT IMPROVES ON GHOST
 *
 * · No vendor lock-in. Ghost REQUIRES Mailgun. Here there is a generic transport
 *   that talks to any provider over SMTP, plus three native ones —Resend, Mailgun
 *   and Postal— and Postal is self-hosted, so you can publish without depending
 *   on any company.
 *
 * · GLOBAL suppression. Ghost's is per newsletter. A spam complaint
 *   should protect you in all of them: whoever reports, reports the domain.
 *
 * · Idempotent, resumable sending. Unique index (campaign, member) on
 *   `nl_deliveries`: if the process dies at email 30,000 of 50,000,
 *   resuming continues where it left off without resending to anyone.
 *
 * · Tiers with four gateways. Ghost only speaks Stripe. With kon-payments
 *   come Lemon Squeezy and Paddle, which are *merchant of record* and handle
 *   VAT — something Ghost cannot offer.
 *
 * · Segments as a declarative query over arbitrary jsonb attributes, not
 *   just by tier and label.
 *
 * · Truly testable: the generic transport wraps the engine driver,
 *   so `mail.fake()` intercepts a whole campaign without touching the network.
 *
 * CONFIGURATION (only what has keys is activated)
 *
 *   Sending — the first available is chosen, or NEWSLETTER_TRANSPORT to pin it:
 *     RESEND_API_KEY
 *     MAILGUN_API_KEY + MAILGUN_DOMAIN [+ MAILGUN_REGION=eu]
 *     POSTAL_URL + POSTAL_API_KEY
 *     (if there is none → generic transport over the Mailer driver)
 *
 *   Bounces — each at /api/newsletter/webhook/<provider>:
 *     MAILGUN_WEBHOOK_SIGNING_KEY
 *     RESEND_WEBHOOK_SECRET
 *     SES_FEEDBACK_ENABLED=true
 *     POSTMARK_WEBHOOK_TOKEN
 *
 *   NEWSLETTER_AUTO_SEND=true → publish a post and the campaign goes out by itself.
 */

import { defineKonSdk, mail, type MailDriver } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Hono } from "hono";

import { mailgunFeedback } from "./feedback/mailgun";
import { postmarkFeedback } from "./feedback/postmark";
import { resendFeedback } from "./feedback/resend";
import { sesFeedback } from "./feedback/ses";
import type { NewsletterDb } from "./newsletter.db";
import { newsletterRateLimits } from "./newsletter.limits";
import { newsletterMailables, newsletterTranslations } from "./newsletter.mails";
import { createNewsletterRouter, newsletterOperations } from "./newsletter.routes";
import { nlCampaigns, nlNewsletters } from "./newsletter.schema";
import { prepareCampaign, sendCampaign } from "./newsletter.service";
import type { BulkTransport, FeedbackAdapter } from "./newsletter.types";
import { mailgunTransport } from "./transports/mailgun";
import { postalTransport } from "./transports/postal";
import { resendTransport } from "./transports/resend";
import { driverTransport } from "./transports/smtp";
import { KON_ID } from "./operations";

export * from "./newsletter.schema";
export * from "./newsletter.types";
export * from "./newsletter.mails";
export * from "./newsletter.tracking";
export * from "./newsletter.limits";
export {
  subscribe,
  confirm,
  unsubscribeByToken,
  suppress,
  unsuppress,
  resolveSegment,
  prepareCampaign,
  sendCampaign,
  applyFeedback,
  renderCampaignMessage,
} from "./newsletter.service";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));
export { driverTransport, resendTransport, mailgunTransport, postalTransport };
export { createNewsletterRouter, newsletterOperations };
export { registerNewsletterPolicy } from "./newsletter.policy";

/**
 * The minimum this kon needs from a published post.
 *
 * Structural and not imported from kon-blog: auto-send is an OPTIONAL
 * dependency, so requiring its type at compile time would tie the two kons. If
 * the event comes in another shape, the guards below discard it.
 */
interface BlogPostLike {
  id: string | number;
  title: string;
  excerpt?: string | null;
  content?: string | null;
  contentHtml?: string | null;
}

/**
 * Chooses the transport.
 *
 * Preference: the one set by `NEWSLETTER_TRANSPORT` → the first configured
 * native one → the generic one over the Mailer driver.
 *
 * The last case is NOT a degraded mode: wrapping the engine driver means
 * supporting any SMTP provider in the world and inheriting `mail.fake()`.
 * It is the correct default option, not a plan B.
 */
export function buildTransport(env = process.env, driver?: MailDriver): BulkTransport {
  const natives = [resendTransport(env), mailgunTransport(env), postalTransport(env)];

  const forced = env.NEWSLETTER_TRANSPORT;
  if (forced) {
    const match = natives.find((t) => t.name === forced);
    if (match?.isConfigured()) return match;
  }

  const available = natives.find((t) => t.isConfigured());
  if (available) return available;

  return driverTransport(driver ?? currentDriver(), {
    ratePerSecond: Number(env.NEWSLETTER_RATE_PER_SECOND ?? 10),
    concurrency: Number(env.NEWSLETTER_CONCURRENCY ?? 4),
  });
}

/** The Mailer's active driver, wrapped so `mail.fake()` intercepts it. */
function currentDriver(): MailDriver {
  return {
    name: mail.driverName,
    // Resolved on every send, not once: if a test calls `mail.fake()`
    // after startup, this transport must switch to writing to the outbox.
    send: (message) => (mail as unknown as { driver: MailDriver }).driver.send(message),
  };
}

/** Registry of feedback adapters; skips those without a secret. */
export function buildFeedbackAdapters(env = process.env): Map<string, FeedbackAdapter> {
  const all = [mailgunFeedback(env), resendFeedback(env), sesFeedback(env), postmarkFeedback(env)];

  const map = new Map<string, FeedbackAdapter>();
  for (const adapter of all) {
    if (adapter.isConfigured()) map.set(adapter.name, adapter);
  }
  return map;
}

/**
 * Auto-send on publish — Ghost's star behavior.
 *
 * Listens to the blog's publish event and generates the campaign. The unique
 * index on `post_id` is what prevents republishing an article (or two
 * workers seeing the same event) from resending the whole newsletter: the second
 * insert creates no row and the function exits.
 */
function wireAutoSend(ctx: KonContext): void {
  if (process.env.NEWSLETTER_AUTO_SEND !== "true") return;

  const db = ctx.db.instance as NewsletterDb;
  // The event arrives INSIDE the request that publishes the post (its RLS
  // transaction, with the publisher's role), and the sending lasts much longer than that
  // request. Outside it and as the system: the `nl_*` tables only let through
  // the system and admin, and the transaction commits when responding.
  const background = ctx.db.background ?? (<T>(fn: () => T) => fn());

  // The name kon-blog emits is `blog:post:published` (routes.ts, on
  // publish and on schedule). Here `blog:published` was listened to, which nobody
  // emits: auto-send never fired.
  ctx.events.on?.("blog:post:published", (payload: unknown) =>
    background(async () => {
      try {
        const raw = payload as { post?: BlogPostLike } | BlogPostLike | undefined;
        const post = (raw && "post" in raw ? raw.post : raw) as BlogPostLike | undefined;
        if (!post?.id || !post.title) return;

        const [newsletter] = await db.select().from(nlNewsletters).limit(1);
        if (!newsletter) {
          ctx.logger.warn("[Newsletter] Auto-send is active but no newsletter has been created");
          return;
        }

        const [campaign] = await db
          .insert(nlCampaigns)
          .values({
            newsletterId: newsletter.id,
            postId: String(post.id),
            subject: post.title,
            previewText: post.excerpt ?? undefined,
            html: post.contentHtml ?? post.content ?? "",
            status: "draft",
          })
          .onConflictDoNothing()
          .returning();

        // A campaign already existed for this post: it is a republication, not a
        // premiere. It is not resent.
        if (!campaign) {
          ctx.logger.info("[Newsletter] The post already had a campaign; not resending", {
            postId: post.id,
          });
          return;
        }

        await prepareCampaign(db, campaign.id);
        await sendCampaign(db, campaign.id, {
          transport: buildTransport(),
          appUrl: ctx.config.siteUrl,
          appName: ctx.config.siteName,
          logger: ctx.logger,
        });
      } catch (err) {
        // A failure here MUST NOT bring down the post's publication. The campaign
        // stays in `draft` and can be launched by hand from the admin.
        ctx.logger.error("[Newsletter] Auto-send failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}

/**
 * Seed: guarantees that at least ONE newsletter exists.
 *
 * Without this the kon started out unusable — `/subscribe` threw "there is no
 * active newsletter" until someone inserted a row by hand.
 * Ghost does the same: it creates the default newsletter on installation.
 * Idempotent: if there are already rows (active or not), it touches nothing.
 */
async function seedDefaultNewsletter(ctx: KonContext): Promise<void> {
  const db = ctx.db.instance as NewsletterDb;
  try {
    const [existing] = await db.select({ id: nlNewsletters.id }).from(nlNewsletters).limit(1);
    if (existing) return;

    await db.insert(nlNewsletters).values({
      slug: "general",
      name: ctx.config.siteName ? `${ctx.config.siteName} newsletter` : "Newsletter",
      description: "General site newsletter",
      publicSignup: true,
      active: true,
    });
    ctx.logger.info('[Newsletter] Default newsletter created ("general")');
  } catch (err) {
    // Table not yet migrated: not fatal, the seed is retried on restart.
    ctx.logger.warn("[Newsletter] Could not seed the default newsletter", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerBusy = false;

/**
 * Campaign scheduler: runs the ones that reached their `scheduledAt`.
 *
 * The column existed and NOBODY read it — scheduling a campaign left it in
 * `scheduled` forever. A 30s interval is enough resolution
 * for email (nobody schedules a newsletter to the second).
 *
 * TWO SAFEGUARDS:
 *
 * · `schedulerBusy` prevents a tick from overlapping the previous one if a send takes more
 *   than 30s (which is normal on large lists).
 *
 * · The conditional UPDATE `status = 'scheduled' → 'sending'` is a CAS on
 *   the database: if there are several workers, only the one that wins the transition
 *   sends. The rest see 0 affected rows and move on.
 */
function startScheduler(ctx: KonContext): void {
  const db = ctx.db.instance as NewsletterDb;

  schedulerTimer = setInterval(async () => {
    if (schedulerBusy) return;
    schedulerBusy = true;

    try {
      // Only scheduled campaigns whose time has come.
      const due = await db
        .select({ id: nlCampaigns.id })
        .from(nlCampaigns)
        .where(
          and(
            eq(nlCampaigns.status, "scheduled"),
            isNotNull(nlCampaigns.scheduledAt),
            lte(nlCampaigns.scheduledAt, new Date())
          )
        )
        .limit(5);

      for (const campaign of due) {
        // CAS: claim the campaign. If another worker claimed it first, the
        // update affects no rows and it is not sent twice.
        const claimed = await db
          .update(nlCampaigns)
          .set({ status: "sending", startedAt: new Date() })
          .where(and(eq(nlCampaigns.id, campaign.id), eq(nlCampaigns.status, "scheduled")))
          .returning({ id: nlCampaigns.id });

        if (claimed.length === 0) continue;

        ctx.logger.info("[Newsletter] Sending scheduled campaign", { campaignId: campaign.id });

        try {
          await prepareCampaign(db, campaign.id).catch(() => 0); // already prepared = ok
          await sendCampaign(db, campaign.id, {
            transport: buildTransport(),
            appUrl: ctx.config.siteUrl,
            appName: ctx.config.siteName,
            logger: ctx.logger,
          });
        } catch (err) {
          ctx.logger.error("[Newsletter] Scheduled campaign failed", {
            campaignId: campaign.id,
            message: err instanceof Error ? err.message : String(err),
          });
          await db
            .update(nlCampaigns)
            .set({ status: "failed" })
            .where(eq(nlCampaigns.id, campaign.id));
        }
      }
    } catch {
      // Table not migrated or DB down: the next tick retries.
    } finally {
      schedulerBusy = false;
    }
  }, 30_000);

  // It does not keep the process alive: if the app wants to exit, it exits.
  schedulerTimer.unref?.();
}

function stopScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export function createNewsletterKon(ctx: KonContext): Hono {
  const transport = buildTransport();
  const adapters = buildFeedbackAdapters();

  if (adapters.size === 0) {
    // Not fatal, but serious: without webhooks nobody tells you about bounces,
    // and you will keep writing to dead addresses until you burn the domain.
    ctx.logger.warn(
      "[Newsletter] No bounce adapters configured — " +
        "bounces or complaints will not be detected. Set MAILGUN_WEBHOOK_SIGNING_KEY, RESEND_WEBHOOK_SECRET, " +
        "SES_FEEDBACK_ENABLED or POSTMARK_WEBHOOK_TOKEN."
    );
  }

  return createNewsletterRouter(ctx, transport, adapters);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`newsletterOperations`), with its OpenAPI, its MCP tool and its fine-grained scope.
 *
 * `createRouter` is the usual one (`createNewsletterKon`): it chooses the transport
 * and the bounce adapters once, and warns if there are none of these.
 */
type AdminDeclaration = NonNullable<KonDefinition["admin"]>;

const definition = defineKonSdk({
  id: KON_ID,
  name: "Newsletter",
  version: manifest.version,
  description:
    "Members, double opt-in, segments and campaigns. Delegated delivery: Resend, Mailgun, Postal or any SMTP",
  icon: "Mail",
  mountPath: "/api/newsletter",
  operations: (ctx: KonContext) =>
    newsletterOperations(ctx, buildTransport(), buildFeedbackAdapters()),

  tables: konTables,

  // kon.json `admin` is the one source (the admin registry reads it); mirrored here so
  // the definition and the manifest never differ.
  admin: {
    category: manifest.admin.category as AdminDeclaration["category"],
    views: manifest.admin.views.map((v) => ({ ...v })) as AdminDeclaration["views"],
  },

  /** See newsletter.limits.ts for the reasoning behind each number. */
  rateLimits: newsletterRateLimits,

  dependencies: {
    // kon-blog and kon-payments are OPTIONAL: without blog there is no auto-send,
    // without payments there is no tier segmentation, and the rest works the same.
    kons: [],
    core: ["auth"],
  },

  hooks: {
    onStartup: async (ctx: KonContext) => {
      // A kon registers its own emails: the host knows nothing about them.
      mail.registerAll(newsletterMailables);
      for (const [locale, entries] of Object.entries(newsletterTranslations)) {
        mail.addTranslations(locale, entries);
      }

      const transport = buildTransport();
      const adapters = Array.from(buildFeedbackAdapters().keys());

      ctx.logger.info(
        `[Newsletter] Transport: ${transport.name} ` +
          `(batch ${transport.batchSize}, ${transport.ratePerSecond}/s) · ` +
          `Bounces:${adapters.length > 0 ? adapters.join(", ") : "none"}`
      );

      await seedDefaultNewsletter(ctx);
      wireAutoSend(ctx);
      startScheduler(ctx);
    },
    // The contract has no onShutdown; onDisable covers hot
    // deactivation, and for process shutdown the timer goes with unref().
    onDisable: async () => {
      stopScheduler();
    },
  },
});

export const kon: KonDefinition = { ...definition, createRouter: createNewsletterKon };

export default kon;
