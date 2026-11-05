/**
 * Kitsuden Newsletter — Routes
 * ============================================================================
 * Three groups with very different access rules:
 *
 *   PUBLIC     — sign-up, confirmation and unsubscribe. No session: the TOKEN authenticates.
 *   WEBHOOKS   — public by necessity; authenticated by the provider's SIGNATURE.
 *   ADMIN      — the rest. Requires an administrator session.
 *
 * Unsubscribe accepts GET and POST. The POST is not a whim: it is what
 * RFC 8058 requires for the one-click that Gmail and Yahoo demand, and the mail
 * client fires it without going through the browser. *
 * Each route is a kon SDK operation (`operations.ts`,
 * docs/kons/README.md): the handler is the usual one; the access, the policy and
 * the schemas are declared.
 */

import {
  isUuid,
  attemptSql,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";

import type { NewsletterDb } from "./newsletter.db";
import { registerNewsletterPolicy } from "./newsletter.policy";
import {
  nlCampaigns,
  nlDeliveries,
  nlMembers,
  nlNewsletters,
  nlSegments,
  nlSuppressions,
} from "./newsletter.schema";
import {
  applyFeedback,
  confirm,
  prepareCampaign,
  resolveSegment,
  sendCampaign,
  subscribe,
  suppress,
  unsubscribeByToken,
  unsuppress,
  type SendOptions,
} from "./newsletter.service";
import {
  parseClickToken,
  parseOpenToken,
  PIXEL_GIF,
  trackingConfigFromEnv,
} from "./newsletter.tracking";
import { defaultLocale, type BulkTransport, type FeedbackAdapter, type SegmentFilter } from "./newsletter.types";
import { KON_ID, registry, ADMIN_ONLY } from "./operations";

const subscribeSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().max(200).optional(),
  locale: z.string().max(8).optional(),
  newsletters: z.array(z.string().max(64)).max(10).optional(),
  /**
   * Attributes that the PUBLIC SIGN-UP can set: only which site it came from.
   *
   * Before it was `z.record(z.unknown())`: anyone wrote whatever attributes
   * they wanted (`{"plan":"pro","vip":true}`) and, since segments filter by
   * attributes, got into campaigns meant for others. And with no size cap.
   * The rest is silently discarded, not rejected: the form does not need to
   * learn which segments exist.
   */
  attributes: z
    .object({
      web: z
        .string()
        .max(40)
        .regex(/^[a-z0-9-]+$/)
        .optional(),
    })
    .strip()
    .optional(),
});

const campaignSchema = z.object({
  newsletterId: z.guid(),
  segmentId: z.guid().optional(),
  subject: z.string().min(1).max(500),
  previewText: z.string().max(300).optional(),
  html: z.string().min(1),
  text: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
});

// ── Operation schemas (OpenAPI and MCP) ──────────────────────────────────────

const QueryToken = z
  .object({ token: z.string().optional().describe("Token from the email link") })
  .passthrough();
const ParamToken = z.object({ token: z.string().describe("Signed tracking token") });
const ParamProvider = z.object({
  provider: z.string().describe("Feedback provider: mailgun | resend | ses | postmark"),
});
const ParamId = z.object({ id: z.string().describe("Campaign id (uuid)") });
const ParamEmail = z.object({ email: z.string().describe("Suppressed address (URL-encoded)") });

const Ok = z.object({ ok: z.literal(true), message: z.string() });
/** Database rows, loose: the panel reads the whole row. */
const Row = z.object({ id: z.string() }).passthrough();

/**
 * Body of the manual suppression. `email` typed: a number reached
 * `normalizeEmail` and blew up on `.trim()` with a 500. A missing one is still
 * the handler's 400 "Missing 'email'".
 */
const NewSuppression = z
  .object({
    email: z.string().max(320).optional().describe("Address to suppress (required)"),
    detail: z.string().max(2000).nullable().optional().describe("Why, for the record"),
  })
  .passthrough();

/**
 * A segment's filter (`SegmentFilter`). Typed: a `status` that was not
 * a list or a date that was not a date reached the query and came out as
 * a 500. What it does not know is ignored, as before.
 */
const SegmentFilterValue = z
  .object({
    status: z.array(z.enum(["pending", "subscribed", "unsubscribed", "cleaned"])).optional(),
    newsletters: z.array(z.string()).optional(),
    locales: z.array(z.string()).optional(),
    tiers: z.array(z.string()).optional().describe('Payment tiers; "free" = no active plan'),
    subscribedBefore: z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date (ISO 8601)" })
      .optional(),
    subscribedAfter: z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date (ISO 8601)" })
      .optional(),
    attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .passthrough();

const PreviewSegment = z
  .object({
    filter: SegmentFilterValue.optional(),
    newsletterId: z.string().optional().describe("Only members subscribed to this newsletter"),
  })
  .passthrough();

export function createNewsletterRouter(
  ctx: KonContext,
  transport: BulkTransport,
  feedbackAdapters: Map<string, FeedbackAdapter>
): Hono {
  return operationsRouter(KON_ID, newsletterOperations(ctx, transport, feedbackAdapters), ctx);
}

/**
 * The kon's operations (docs/kons/README.md), in the usual order:
 * public, tracking, portal, webhooks and, at the end, administration.
 */
export function newsletterOperations(
  ctx: KonContext,
  transport: BulkTransport,
  feedbackAdapters: Map<string, FeedbackAdapter>
): AnyOperation[] {
  registerNewsletterPolicy();
  const app = registry();
  const db = ctx.db.instance as NewsletterDb;

  /**
   * The newsletter's public routes are authorized by a TOKEN (confirmation,
   * unsubscribe, signed pixel and click) or the provider's SIGNATURE (webhooks), not an
   * account: to the database the one asking is the anonymous user, and the `nl_*` tables
   * (0002_system_without_user.sql) only let through the system and admin. So
   * those operations run as the system, after validating the token.
   */
  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());
  const background = ctx.db.background ?? (<T>(fn: () => T) => fn());

  const sendOptions = (): SendOptions => ({
    transport,
    appUrl: ctx.config.siteUrl,
    appName: ctx.config.siteName,
    logger: ctx.logger,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * POST /subscribe — sign-up with double opt-in.
   *
   * It ALWAYS responds the same, whether the address exists or not. Distinguishing the cases
   * would turn this public endpoint into an oracle for knowing who is on
   * the list.
   */
  app.post(
    "/subscribe",
    {
      id: "subscribe",
      summary: "Subscribe an address (double opt-in)",
      description:
        "Public sign-up. Sends a confirmation email to the address (the subscription is only active after the link in it is followed). Always answers the same message whether the address was new, already subscribed or suppressed, so it cannot be used to learn who is on the list. 400 when the email is not valid.",
      access: "public",
      // The 400 `{ error: { code: "VALIDATION", … } }` is the usual
      // contract (read by the portal widget): the handler still gives it.
      input: { body: subscribeSchema, validatesHandler: true },
      output: { schema: Ok },
    },
    async (c, input) => {
      const body = input.body ?? null;
      const parsed = subscribeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: "VALIDATION", message: "Invalid email" } }, 400);
      }

      /**
       * It responds WITHOUT waiting for the sign-up.
       *
       * The text was already the same in all cases, but the TIME was not: a new
       * address gets the confirmation email before responding
       * (hundreds of milliseconds of SMTP) and an already subscribed, suppressed or
       * waiting one does not. By timing the response you could tell who is on the list. Now
       * all of that happens afterwards, and a failure is logged instead of reported.
       */
      // Outside the request's transaction: runs AFTER responding.
      void background(() =>
        subscribe(
          db,
          {
            ...parsed.data,
            ip:
              c.req.header("cf-connecting-ip") ??
              c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
            source: "web",
          },
          { appUrl: ctx.config.siteUrl }
        )
      ).catch((err) => {
        ctx.logger.error("[Newsletter] Sign-up failure", {
          message: err instanceof Error ? err.message : String(err),
        });
      });

      return c.json({
        ok: true,
        message: "If the address is valid, you will receive an email to confirm the subscription.",
      });
    }
  );

  /** GET /confirm?token= — completes the double opt-in. */
  app.get(
    "/confirm",
    {
      id: "confirm-subscription",
      summary: "Confirm a subscription",
      description:
        "Closes the double opt-in with the token from the confirmation email, and sends the welcome email. Confirming twice is fine. 400 when the token is unknown or expired.",
      access: "public",
      input: { query: QueryToken },
      output: { schema: Ok },
    },
    async (c) => {
      const token = c.req.query("token") ?? "";
      const ip =
        c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();

      const result = await asSystem(() =>
        confirm(db, token, { ip, source: "web", appUrl: ctx.config.siteUrl })
      );
      if (!result.ok) {
        return c.json(
          {
            error: {
              code: "INVALID_TOKEN",
              message: "Invalid or expired confirmation link",
            },
          },
          400
        );
      }
      return c.json({ ok: true, message: "Subscription confirmed" });
    }
  );

  /**
   * Unsubscribe. GET for the footer link, POST for the one-click (RFC 8058).
   *
   * It never returns a detailed 404: confirming whether a token exists would leak
   * information. An invalid token responds the same as a valid one.
   */
  const handleUnsubscribe = async (c: Context) => {
    const token = c.req.query("token") ?? "";
    await asSystem(() => unsubscribeByToken(db, token));
    return c.json({ ok: true, message: "Unsubscribe processed" });
  };

  app.get(
    "/unsubscribe",
    {
      id: "unsubscribe",
      summary: "Unsubscribe (footer link)",
      description:
        "Unsubscribes the member that owns the token from the unsubscribe link of an email. Always answers the same, valid token or not, so it cannot be used to probe tokens.",
      access: "public",
      input: { query: QueryToken },
      output: { schema: Ok },
    },
    handleUnsubscribe
  );
  app.post(
    "/unsubscribe",
    {
      id: "unsubscribe-one-click",
      summary: "Unsubscribe (RFC 8058 one-click)",
      description:
        "The one-click unsubscribe that mail clients (Gmail, Yahoo) send as a POST to the List-Unsubscribe URL; the token goes in the query string and the body is ignored. Same answer as the GET.",
      access: "public",
      // Unsubscribing twice leaves the same result.
      idempotent: true,
      input: { query: QueryToken },
      output: { schema: Ok },
    },
    handleUnsubscribe
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TRACKING — public, authenticated by SIGNATURE in the token
  // ═══════════════════════════════════════════════════════════════════════

  const tracking = trackingConfigFromEnv(ctx.config.siteUrl);

  /**
   * GET /t/o/:token.gif — open pixel.
   *
   * It ALWAYS returns the GIF, whether the token validates or not. A 404 in an email looks
   * like a broken gap in the client, and would reveal which tokens exist.
   */
  app.get(
    "/t/o/:token",
    {
      id: "open-pixel",
      summary: "Open-tracking pixel",
      description:
        "A 1x1 GIF embedded in campaign emails; a valid signed token records the first open of that delivery. Always returns the GIF, valid token or not. Only active when open tracking is enabled.",
      access: "public",
      input: { params: ParamToken },
      output: { type: "image/gif", description: "1x1 transparent GIF" },
      mcp: { exclude: "tracking pixel loaded by mail clients; returns image bytes" },
    },
    async (c) => {
      const raw = c.req.param("token").replace(/\.gif$/, "");
      const parsed = tracking.opens ? parseOpenToken(raw, tracking.secret) : null;

      if (parsed) {
        // `is null` to keep the FIRST open: mail clients
        // reload images and overwriting would give the time of the
        // last time someone looked at the email, not when they opened it.
        // In its SAVEPOINT: a failure here cannot leave the transaction aborted.
        await attemptSql(
          () =>
            asSystem(() =>
              db
                .update(nlDeliveries)
                .set({ openedAt: new Date() })
                .where(and(eq(nlDeliveries.id, parsed.deliveryId), isNull(nlDeliveries.openedAt)))
            ),
          undefined
        );
      }

      c.header("Content-Type", "image/gif");
      c.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
      return c.body(PIXEL_GIF as unknown as ArrayBuffer);
    }
  );

  /**
   * GET /t/c/:token — records the click and redirects.
   *
   * The destination is INSIDE the signature, so it cannot be changed. If the token
   * does not validate it responds 400 instead of redirecting: an open redirector on your
   * domain is ammunition for phishing.
   */
  app.get(
    "/t/c/:token",
    {
      id: "redirect-click",
      summary: "Click-tracking redirect",
      description:
        "The tracked link of a campaign email: records the click and answers 302 to the destination signed inside the token. 400 when the token does not validate (never an open redirect). Only active when click tracking is enabled.",
      access: "public",
      input: { params: ParamToken },
      output: { status: 302, description: "Redirect to the signed destination" },
      mcp: { exclude: "browser redirect for email links; no JSON result" },
    },
    async (c) => {
      const parsed = tracking.clicks
        ? parseClickToken(c.req.param("token"), tracking.secret)
        : null;

      if (!parsed) {
        return c.json({ error: { code: "INVALID_TOKEN", message: "Invalid link" } }, 400);
      }

      // A click implies an open, even if the pixel was blocked — and in fact
      // it is the more reliable signal of the two.
      await attemptSql(
        () =>
          asSystem(() =>
            db
              .update(nlDeliveries)
              .set({ clickedAt: new Date() })
              .where(and(eq(nlDeliveries.id, parsed.deliveryId), isNull(nlDeliveries.clickedAt)))
          ),
        undefined
      );

      return c.redirect(parsed.url, 302);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // PORTAL — form embeddable on any site
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * GET /portal.js — self-contained sign-up widget.
   *
   * No dependencies, no build, no CDN: paste a <script> tag on
   * any site (Astro, WordPress, plain HTML) and it works. It is the
   * equivalent of Ghost's Portal, in 2 KB.
   */
  app.get(
    "/portal.js",
    {
      id: "get-portal-script",
      summary: "Embeddable sign-up widget (JavaScript)",
      description:
        "Self-contained script that mounts a sign-up form in every `[data-kitsuden-newsletter]` element of a page. Public.",
      access: "public",
      output: { type: "application/javascript" },
      mcp: { exclude: "JavaScript asset for web pages, not data" },
    },
    (c) => {
      c.header("Content-Type", "application/javascript; charset=utf-8");
      c.header("Cache-Control", "public, max-age=300");
      return c.body(portalScript(ctx.config.siteUrl, ctx.config.siteName, defaultLocale()));
    }
  );

  /** Ready-to-use sign-up page, in case you don't want to embed anything. */
  app.get(
    "/portal",
    {
      id: "get-portal-page",
      summary: "Ready-made sign-up page (HTML)",
      description:
        "A minimal HTML page with the sign-up widget, for sites that embed nothing. Public.",
      access: "public",
      output: { type: "text/html" },
      mcp: { exclude: "HTML page for browsers, not data" },
    },
    (c) => {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(
        `<!doctype html><html lang="${escapeHtml(defaultLocale())}"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>${escapeHtml(ctx.config.siteName)}</title></head><body>` +
          `<div data-kitsuden-newsletter></div>` +
          `<script src="${ctx.config.siteUrl}/api/newsletter/portal.js"></script>` +
          `</body></html>`
      );
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // WEBHOOKS — public, authenticated by SIGNATURE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * POST /webhook/:provider
   *
   * The body is read with `c.req.text()`, NOT with `c.req.json()`: signatures
   * are computed over the exact bytes, and re-serializing an object changes
   * the spacing and breaks verification. That is why the operation does NOT declare
   * a body: the SDK neither reads nor interprets it, and it reaches the adapter intact.
   */
  app.post(
    "/webhook/:provider",
    {
      id: "receive-webhook",
      summary: "Delivery feedback webhook",
      description:
        "Bounce/complaint/unsubscribe events from the email provider, authenticated by the provider's signature over the raw body. 404 for an unconfigured provider, 400 for an invalid signature or payload; irrelevant events answer 200 with `ignored`.",
      access: "public",
      input: { params: ParamProvider },
      output: {
        schema: z
          .object({
            ok: z.literal(true),
            ignored: z.boolean().optional(),
            received: z.number().int().optional(),
            applied: z.number().int().optional(),
          })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: {
        exclude: "called by the email provider, authenticated by its signature over the raw body",
      },
    },
    async (c) => {
      const name = c.req.param("provider");
      const adapter = feedbackAdapters.get(name);
      if (!adapter) return c.json({ error: "Unknown provider" }, 404);

      const rawBody = await c.req.text();
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, key) => {
        headers[key] = value;
      });

      let events;
      try {
        events = await adapter.parse(rawBody, headers);
      } catch (err) {
        ctx.logger.error("[Newsletter] Error processing webhook", {
          provider: name,
          message: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "Payload no procesable" }, 400);
      }

      // Invalid signature. The reason is not leaked.
      if (events === null) {
        ctx.logger.warn("[Newsletter] Webhook with invalid signature", { provider: name });
        return c.json({ error: "Invalid signature" }, 400);
      }

      // Valid signature but irrelevant event: 200 so it does not retry.
      if (!events || events.length === 0) return c.json({ ok: true, ignored: true });

      let applied = 0;
      for (const event of events) {
        if (await asSystem(() => applyFeedback(db, event))) applied++;
      }

      return c.json({ ok: true, received: events.length, applied });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN
  // ═══════════════════════════════════════════════════════════════════════

  // The human admin, or an agent with `admin`, `newsletter:*` or
  // `kon:newsletter:*` (common engine rule; in the database, 0003). Before, an
  // agent with `admin` got 403 here (an earlier audit, e2e test over HTTP). It was
  // applied by an `admin.use("*")`; now each operation declares it
  // (`ADMIN_ONLY`, newsletter.policy.ts) and it is checked before reading the body.

  app.get(
    "/newsletters",
    {
      id: "list-newsletters",
      summary: "List newsletters",
      description: "Every newsletter (the lists members subscribe to), oldest first. Admin only.",
      access: "session",
      permission: ADMIN_ONLY,
      output: { schema: z.object({ newsletters: z.array(Row) }) },
    },
    async (c) => {
      const rows = await db.select().from(nlNewsletters).orderBy(nlNewsletters.createdAt);
      return c.json({ newsletters: rows });
    }
  );

  app.get(
    "/members",
    {
      id: "list-members",
      summary: "List members",
      description:
        "The most recent members (default 100, max 500): email, name, status, locale and consent date. Personal data: admin only.",
      access: "session",
      permission: ADMIN_ONLY,
      input: {
        query: z
          .object({ limit: z.string().optional().describe("How many, max 500 (default 100)") })
          .passthrough(),
      },
      output: { schema: z.object({ members: z.array(Row) }) },
    },
    async (c) => {
      const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
      const rows = await db
        .select({
          id: nlMembers.id,
          email: nlMembers.email,
          name: nlMembers.name,
          status: nlMembers.status,
          locale: nlMembers.locale,
          consentAt: nlMembers.consentAt,
          createdAt: nlMembers.createdAt,
        })
        .from(nlMembers)
        .orderBy(desc(nlMembers.createdAt))
        .limit(limit);
      return c.json({ members: rows });
    }
  );

  app.get(
    "/suppressions",
    {
      id: "list-suppressions",
      summary: "List suppressed addresses",
      description:
        "The latest 500 suppressed addresses (bounces, complaints, unsubscribes, manual), which no campaign will ever write to. Admin only.",
      access: "session",
      permission: ADMIN_ONLY,
      output: { schema: z.object({ suppressions: z.array(Row) }) },
    },
    async (c) => {
      const rows = await db
        .select()
        .from(nlSuppressions)
        .orderBy(desc(nlSuppressions.createdAt))
        .limit(500);
      return c.json({ suppressions: rows });
    }
  );

  app.post(
    "/suppressions",
    {
      id: "suppress-address",
      summary: "Suppress an address",
      description:
        "Adds an address to the global suppression list: no campaign of any newsletter will write to it again. Suppressing an address twice keeps the first reason. Admin only. 400 when `email` is missing.",
      access: "session",
      permission: ADMIN_ONLY,
      // Suppressing twice leaves the same result (`onConflictDoNothing`).
      idempotent: true,
      input: { body: NewSuppression.optional() },
      output: { status: 201, schema: z.object({ ok: z.literal(true) }) },
    },
    async (c, input) => {
      const body = (input.body ?? {}) as { email?: string; detail?: string };
      if (!body.email) return c.json({ error: "Missing 'email'" }, 400);
      await suppress(db, body.email, "manual", "admin", body.detail);
      return c.json({ ok: true }, 201);
    }
  );

  app.delete(
    "/suppressions/:email",
    {
      id: "remove-suppression",
      summary: "Remove a suppression",
      description:
        "Lets campaigns write to an address again. Only by explicit human decision: a suppressed address usually bounced or complained. Admin only. Answers ok whether or not it was suppressed.",
      access: "session",
      permission: ADMIN_ONLY,
      input: { params: ParamEmail },
      output: { schema: z.object({ ok: z.literal(true) }) },
    },
    async (c) => {
      // Hono already decodes the parameter; the second decode is the usual one,
      // but a stray `%` (`a%zz@x`) threw URIError and came out as a 500.
      const rawValue = c.req.param("email");
      let email = rawValue;
      try {
        email = decodeURIComponent(rawValue);
      } catch {
        // It stays as is.
      }
      await unsuppress(db, email);
      return c.json({ ok: true });
    }
  );

  /** Previews how many people a segment would reach, without sending anything. */
  app.post(
    "/segments/preview",
    {
      id: "preview-segment",
      summary: "Preview a segment",
      description:
        "How many members a segment filter would reach (suppressed addresses always excluded), with a sample of 10 emails. Sends nothing. Admin only.",
      access: "session",
      permission: ADMIN_ONLY,
      readOnly: true,
      input: { body: PreviewSegment.optional() },
      output: {
        schema: z.object({ total: z.number().int(), sample: z.array(z.string()) }),
      },
    },
    async (c, input) => {
      const body = (input.body ?? {}) as {
        filter?: SegmentFilter;
        newsletterId?: string;
      };
      const members = await resolveSegment(db, body.filter ?? {}, body.newsletterId);
      return c.json({
        total: members.length,
        sample: members.slice(0, 10).map((m) => m.email),
      });
    }
  );

  app.get(
    "/segments",
    {
      id: "list-segments",
      summary: "List segments",
      description: "Every saved segment (a named member filter campaigns can target). Admin only.",
      access: "session",
      permission: ADMIN_ONLY,
      output: { schema: z.object({ segments: z.array(Row) }) },
    },
    async (c) => {
      const rows = await db.select().from(nlSegments);
      return c.json({ segments: rows });
    }
  );

  app.get(
    "/campaigns",
    {
      id: "list-campaigns",
      summary: "List campaigns",
      description: "The latest 100 campaigns, newest first, with status and stats. Admin only.",
      access: "session",
      permission: ADMIN_ONLY,
      output: { schema: z.object({ campaigns: z.array(Row) }) },
    },
    async (c) => {
      const rows = await db
        .select()
        .from(nlCampaigns)
        .orderBy(desc(nlCampaigns.createdAt))
        .limit(100);
      return c.json({ campaigns: rows });
    }
  );

  app.post(
    "/campaigns",
    {
      id: "create-campaign",
      summary: "Create a campaign (draft)",
      description:
        "Creates a draft campaign for a newsletter (optionally for a segment and a scheduled time). Nothing is sent: use prepare and send. Admin only. 400 with `issues` when the body is not valid; 409 when the newsletter or segment does not exist.",
      access: "session",
      permission: ADMIN_ONLY,
      // The 400 `{ error: { code: "VALIDATION", issues } }` is the usual one.
      input: { body: campaignSchema, validatesHandler: true },
      output: { status: 201, schema: z.object({ campaign: Row }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const body = input.body ?? null;
      const parsed = campaignSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: "VALIDATION", issues: parsed.error.issues } }, 400);
      }

      const [created] = await db
        .insert(nlCampaigns)
        .values({
          ...parsed.data,
          scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : undefined,
          status: "draft",
        })
        .returning();

      return c.json({ campaign: created }, 201);
    }
  );

  /**
   * Previews the email exactly as a specific member will receive it,
   * including their unsubscribe URL. Without sending anything.
   */
  app.get(
    "/campaigns/:id/preview",
    {
      id: "preview-campaign",
      summary: "Preview a campaign email",
      description:
        "Renders the campaign email as a given address would receive it (`email`, default preview@example.com), unsubscribe link included. Sends nothing. `format=html` returns the HTML itself instead of JSON. Admin only. 404 if the campaign does not exist.",
      access: "session",
      permission: ADMIN_ONLY,
      input: {
        params: ParamId,
        query: z
          .object({
            email: z.string().optional().describe("Address to render it for"),
            format: z.string().optional().describe("`html`: the HTML itself, not JSON"),
          })
          .passthrough(),
      },
      output: {
        schema: z.object({ message: z.record(z.string(), z.unknown()) }),
        description:
          "The rendered message (subject, html, text, headers…); text/html with format=html",
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const [campaign] = await db
        .select()
        .from(nlCampaigns)
        .where(eq(nlCampaigns.id, c.req.param("id")))
        .limit(1);
      if (!campaign) return c.json({ error: "Campaign not found" }, 404);

      const [newsletter] = await db
        .select()
        .from(nlNewsletters)
        .where(eq(nlNewsletters.id, campaign.newsletterId))
        .limit(1);

      const { renderCampaignMessage } = await import("./newsletter.service");
      const message = renderCampaignMessage(
        campaign,
        newsletter,
        {
          email: c.req.query("email") ?? "preview@example.com",
          name: "Preview",
          locale: defaultLocale(),
          unsubToken: "PREVIEW_TOKEN",
        },
        sendOptions()
      );

      if (c.req.query("format") === "html") {
        c.header("Content-Type", "text/html; charset=utf-8");
        return c.body(message.html);
      }
      return c.json({ message });
    }
  );

  /** Resolves the segment and creates the deliveries. It does not send. */
  app.post(
    "/campaigns/:id/prepare",
    {
      id: "prepare-campaign",
      summary: "Prepare a campaign",
      description:
        "Resolves the campaign's segment and creates one pending delivery per recipient (suppressed addresses excluded). Sends nothing; safe to repeat before sending. Admin only. Returns the number of recipients; 400 when the campaign does not exist or was already sent.",
      access: "session",
      permission: ADMIN_ONLY,
      input: { params: ParamId },
      output: { schema: z.object({ ok: z.literal(true), recipients: z.number().int() }) },
    },
    async (c) => {
      // An id that is not a uuid is not taken to the query: the Postgres error
      // came out in the 400 with the query inside and left the request
      // transaction aborted. It is a campaign that does not exist.
      if (!isUuid(c.req.param("id"))) {
        return c.json({ error: `Campaign ${c.req.param("id")} not found` }, 400);
      }
      try {
        const recipients = await prepareCampaign(db, c.req.param("id"));
        return c.json({ ok: true, recipients });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  );

  /**
   * Launches the send. Returns immediately: a large campaign takes minutes or
   * hours and keeping the HTTP request open would make it fail by timeout.
   * Progress is queried at /campaigns/:id/stats.
   */
  app.post(
    "/campaigns/:id/send",
    {
      id: "send-campaign",
      summary: "Send a campaign",
      description:
        "Starts sending the campaign to its recipients through the configured email provider (a draft is prepared first). Returns 202 at once; follow progress with the stats operation. Cannot be undone. Admin only. 404 if it does not exist, 409 if it is already sending.",
      access: "session",
      permission: ADMIN_ONLY,
      // Sends real email to the whole list.
      sensitive: true,
      input: { params: ParamId },
      output: {
        status: 202,
        schema: z.object({ ok: z.literal(true), status: z.literal("sending") }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c) => {
      const id = c.req.param("id");
      const [campaign] = await db.select().from(nlCampaigns).where(eq(nlCampaigns.id, id)).limit(1);
      if (!campaign) return c.json({ error: "Campaign not found" }, 404);
      if (campaign.status === "sending") return c.json({ error: "Already being sent" }, 409);

      if (campaign.status === "draft") {
        /**
         * Two sends almost at once: this one read «draft», but the other's
         * background send had already moved it to «sending» before `prepareCampaign`
         * re-read it, and that threw a bare `Error` → 500 (Schemathesis).
         * It is the same case as the 409 above.
         */
        try {
          await prepareCampaign(db, id);
        } catch (err) {
          const messageValue = err instanceof Error ? err.message : "";
          if (messageValue.startsWith("The campaign is already in state")) {
            return c.json({ error: "Already being sent" }, 409);
          }
          throw err;
        }
      }

      // Minutes or hours: outside the request's transaction, which
      // commits when responding with the 202.
      void background(() =>
        sendCampaign(db, id, sendOptions()).catch((err) => {
          ctx.logger.error("[Newsletter] Send failed", {
            campaignId: id,
            message: err instanceof Error ? err.message : String(err),
          });
          return db.update(nlCampaigns).set({ status: "failed" }).where(eq(nlCampaigns.id, id));
        })
      );

      return c.json({ ok: true, status: "sending" }, 202);
    }
  );

  app.get(
    "/campaigns/:id/stats",
    {
      id: "get-campaign-stats",
      summary: "Campaign progress and stats",
      description:
        "Status and counters of a campaign, plus the breakdown of its deliveries by status (the source of truth while sending). Admin only. 404 if it does not exist.",
      access: "session",
      permission: ADMIN_ONLY,
      input: { params: ParamId },
      output: {
        schema: z.object({
          status: z.string(),
          stats: z.unknown(),
          breakdown: z.array(z.object({ status: z.string(), count: z.number().int() })),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const id = c.req.param("id");
      const [campaign] = await db.select().from(nlCampaigns).where(eq(nlCampaigns.id, id)).limit(1);
      if (!campaign) return c.json({ error: "Campaign not found" }, 404);

      // The breakdown comes from the deliveries, not from the aggregate counter: if the two
      // disagree, the truth is in the rows.
      const breakdown = await db
        .select({ status: nlDeliveries.status, count: sql<number>`count(*)::int` })
        .from(nlDeliveries)
        .where(eq(nlDeliveries.campaignId, id))
        .groupBy(nlDeliveries.status);

      return c.json({ status: campaign.status, stats: campaign.stats, breakdown });
    }
  );

  return app.ops;
}

/** Escapes for embedding in HTML. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string
  );
}

/** Escapes for embedding in a JavaScript string literal. */
function escapeJs(value: string): string {
  return JSON.stringify(value);
}

/**
 * The sign-up widget, as self-contained JavaScript.
 *
 * It is served as a string and not as a file because it needs to know the
 * instance URL, which is only known at runtime.
 *
 * Decisions:
 * · Inline styles with CSS variables: it inherits the host site's typography
 *   and can be re-themed without touching the script.
 * · Generic success message, the same one the API returns — the widget must
 *   not reveal whether an address was already on the list.
 * · Nothing external is loaded: a third-party widget that brings dependencies is
 *   a supply chain vector on someone else's site.
 */
function portalScript(appUrl: string, siteName: string, locale: string): string {
  return `(function () {
  "use strict";
  var API = ${escapeJs(appUrl.replace(/\/$/, ""))} + "/api/newsletter/subscribe";
  var NAME = ${escapeJs(siteName)};

  function mount(host) {
    if (host.dataset.kitsudenMounted) return;
    host.dataset.kitsudenMounted = "1";

    var newsletters = (host.getAttribute("data-newsletters") || "")
      .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var locale = host.getAttribute("data-locale") || ${escapeJs(locale)};

    var form = document.createElement("form");
    form.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;font:inherit";

    var input = document.createElement("input");
    input.type = "email";
    input.required = true;
    input.placeholder = host.getAttribute("data-placeholder") || "you@email.com";
    input.style.cssText =
      "flex:1 1 220px;padding:10px 12px;border:1px solid var(--kitsuden-border,#d1d5db);" +
      "border-radius:8px;font:inherit;color:inherit;background:transparent";
    input.setAttribute("aria-label", "Email address");

    var button = document.createElement("button");
    button.type = "submit";
    button.textContent = host.getAttribute("data-cta") || "Subscribe";
    button.style.cssText =
      "padding:10px 18px;border:0;border-radius:8px;cursor:pointer;font:inherit;" +
      "background:var(--kitsuden-accent,#0891b2);color:#fff";

    var status = document.createElement("p");
    status.setAttribute("role", "status");
    status.style.cssText = "margin:10px 0 0;font-size:14px;opacity:.85";

    form.appendChild(input);
    form.appendChild(button);
    host.appendChild(form);
    host.appendChild(status);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      button.disabled = true;
      status.textContent = "Sending…";

      var payload = { email: input.value, locale: locale };
      if (newsletters.length) payload.newsletters = newsletters;

      fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) { return res.json().catch(function () { return {}; }); })
        .then(function (data) {
          if (data && data.ok) {
            form.style.display = "none";
            status.textContent =
              data.message || "Check your email to confirm your subscription to " + NAME + ".";
          } else {
            button.disabled = false;
            status.textContent = "The sign-up could not be processed. Please try again.";
          }
        })
        .catch(function () {
          button.disabled = false;
          status.textContent = "Network error. Please try again.";
        });
    });
  }

  function init() {
    var nodes = document.querySelectorAll("[data-kitsuden-newsletter]");
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;
}
