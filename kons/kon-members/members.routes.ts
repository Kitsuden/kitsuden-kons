import {
  repo,
  withSavepoint,
  mail,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import { canAccess, viewerLevel, type ContentGate } from "./members.access.js";
import { accessMailActive, registerMembersMails, accessUrl } from "./members.mails.js";
import "./members.policy.js"; // registers the "member" and "member-tier" policies
import { memberTiers, members, type Member } from "./members.schema.js";
import {
  compAccess,
  consumeSigninToken,
  issueSigninToken,
  loadGrants,
  loadTiers,
  memberFromSession,
  normalizeEmail,
  revokeAccess,
  revokeSession,
  upsertMember,
} from "./members.service.js";
import { KON_ID, registry, onMembers } from "./operations.js";

/**
 * READER session cookie.
 *
 * A different name from the CMS's on purpose: they are two separate identity
 * systems, and sharing a cookie would be one bug away from a subscriber
 * inheriting backoffice permissions.
 */
const ENV_VARS = "NODE_ENV";
const SESSION_COOKIE = "kitsuden_member";

// ── FormRequests ─────────────────────────────────────────────────────────────

const SigninRequest = z.object({
  email: z.string().email(),
  name: z.string().max(200).optional(),
});

const CreateTier = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  level: z.number().int().min(0).max(100),
  monthlyPriceCents: z.number().int().min(0).optional(),
  yearlyPriceCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  benefits: z.array(z.string()).optional(),
  visible: z.boolean().optional(),
});

const GateCheck = z.object({
  visibility: z.enum(["public", "members", "paid"]),
  minTierLevel: z.number().int().min(0).optional(),
});

const CompAccess = z.object({
  memberId: z.string().min(1),
  tierId: z.string().min(1),
  endsAt: z.string().datetime().optional(),
});

/**
 * `POST /admin/access/revoke` read the JSON raw (`.catch(() => ({}))`) and
 * answers its own 400 if a field is missing: both are optional here.
 */
const RevokeAccess = z
  .object({
    memberId: z.string().optional(),
    tierId: z.string().optional(),
  })
  .passthrough()
  .optional();

/** `POST /signin/verify`: the token arrives in the query (email link) or in the body. */
const VerifyQuery = z
  .object({ token: z.string().optional().describe("Magic-link token (from the e-mail link)") })
  .passthrough();
const VerifyBody = z
  .object({ token: z.unknown().optional().describe("Magic-link token, if not in the query") })
  .passthrough()
  .optional();

// ── Outputs (OpenAPI and MCP) ────────────────────────────────────────────────

/** A database row: it carries `id`, and the rest as is. */
const Row = z.object({ id: z.string() }).passthrough();
const Obj = z.record(z.string(), z.unknown());
const Done = z.object({ ok: z.literal(true) });
/** The PORTAL member (`publicMember`): without internal notes. */
const PublicMember = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    status: z.string(),
    newsletterSubscribed: z.boolean(),
    createdAt: z.unknown(),
  })
  .passthrough();

const ParamId = z.object({ id: z.string().describe("Member id") });

// ── Router ───────────────────────────────────────────────────────────────────

export function createMembersRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, membersOperations(ctx), ctx);
}

export function membersOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;
  registerMembersMails();

  /**
   * The reader PORTAL has no identity in Postgres.
   *
   * Its routes run in the request's RLS transaction like any other, but the one
   * asking is a reader with a member cookie (or nobody), not a CMS account: to
   * the database it is the anonymous user, and the member tables
   * (0002_personal_data_rls.sql) show nothing to the anonymous user, rightly so.
   * What authorizes here is holding the token —the cookie or the magic link—,
   * and only the application can check that. So these operations run as the
   * SYSTEM, and each one limits itself to the row the token points to.
   */
  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  /** The backoffice requires a CMS session (`access: "session"`); the portal does not. */

  /** Member of the request, if it carries a valid cookie. */
  const viewerFrom = async (c: Context) =>
    asSystem(() => memberFromSession(db, getCookie(c, SESSION_COOKIE)));

  // ═══════════════════════════════════════════════════════════════════════════
  // Reader portal — public
  // ═══════════════════════════════════════════════════════════════════════════

  /** Plans offered. Public: the pricing page needs it. */
  app.get(
    "/tiers",
    {
      id: "list-plans",
      summary: "List membership tiers",
      description:
        "The active, visible membership tiers (plans) ordered by level, with prices and benefits. Public: the pricing page needs it.",
      access: "public",
      output: { schema: z.object({ data: z.array(Row) }) },
    },
    async (c) => {
      // `member_tiers` has no RLS: plans are public.
      const rows = await repo(memberTiers, { db })
        .filter({ active: true, visible: true })
        .orderBy("level")
        .all();
      return c.json({ data: rows });
    }
  );

  /**
   * Requests a magic link.
   *
   * ALWAYS responds the same, whether the email exists or not. Distinguishing
   * the two cases would turn this endpoint into an oracle for finding out who
   * is subscribed to your publication — which on some topics is sensitive
   * information about real people.
   */
  app.post(
    "/signin",
    {
      id: "request-access-link",
      summary: "Request a reader magic link",
      description:
        "Sends a one-time sign-in link to the e-mail (creating the member if new). Always answers the same, whether the address is registered or not, and never returns the token. Public; sends an e-mail.",
      access: "public",
      input: { body: SigninRequest },
      output: { schema: z.object({ ok: z.literal(true), message: z.string() }) },
    },
    async (c, { body: bodyValue }) => {
      const { email, name } = bodyValue as z.infer<typeof SigninRequest>;

      try {
        // In a SAVEPOINT: the failure is swallowed (see below), and without it it would leave the
        // request transaction aborted; Postgres would turn the COMMIT into a
        // ROLLBACK and the host would respond 500, exactly the difference that must
        // not be visible from outside.
        const { member, token } = await withSavepoint(() =>
          asSystem(async () => {
            const m = await upsertMember(db, { email, name, source: "portal" });
            return { member: m, token: await issueSigninToken(db, m.id) };
          })
        );

        // `null` = one was just sent. Another is not sent, and the response is
        // the same: «throttled» and «sent» cannot be told apart from outside.
        // The token travels ONLY by email (and by the event, for other
        // deliveries); never in the response. Before, only the event was emitted and
        // nobody listened: the email never went out (see members.mails.ts).
        if (token) {
          await ctx.events?.emit?.("members.signin-requested", {
            memberId: member.id,
            email: normalizeEmail(email),
            token,
          });
          if (accessMailActive()) {
            // Without waiting: SMTP time must not distinguish «sent» from
            // «throttled» (the same reason as the kon-newsletter sign-up).
            const signinUrl = accessUrl(ctx.config.siteUrl, token);
            void mail
              .send("members.signin", { to: normalizeEmail(email), name, signinUrl })
              .then((r) => {
                if (!r.ok)
                  ctx.logger.error("[members] sign-in email was not sent", {
                    err: String(r.error),
                  });
              })
              .catch((err) => {
                ctx.logger.error("[members] failure sending the sign-in email", {
                  err: String(err),
                });
              });
          }
        }
      } catch (err) {
        // Not even an internal failure should change the response: the difference
        // in behavior would be the very oracle we are trying to avoid.
        ctx.logger.error("[members] failure issuing magic link", { err: String(err) });
      }

      return c.json({
        ok: true,
        message: "If that email is registered, you will receive a sign-in link.",
      });
    }
  );

  /** Consumes the link and opens a session. */
  app.post(
    "/signin/verify",
    {
      id: "verify-access-link",
      summary: "Consume a reader magic link",
      description:
        "Consumes the one-time token (query `token`, or `token` in the body) and opens the reader session as an httpOnly cookie. 401 if the link is invalid, used or expired (same error for the three). Public.",
      access: "public",
      input: { query: VerifyQuery, body: VerifyBody },
      output: { schema: z.object({ data: PublicMember }) },
      errors: ["KITSUDEN_E_UNAUTHENTICATED"],
      mcp: {
        exclude: "Opens a reader session cookie in the browser that followed the e-mail link",
      },
    },
    async (c, { body: bodyValue }) => {
      // The body was already read by the SDK (`undefined` if it came empty).
      const token = c.req.query("token") ?? (bodyValue as { token?: unknown } | undefined)?.token;
      if (!token || typeof token !== "string") {
        return c.json({ error: "Missing token" }, 400);
      }

      const result = await asSystem(() =>
        consumeSigninToken(db, token, {
          userAgent: c.req.header("user-agent"),
        })
      );
      if (!result) {
        // An expired, already used or nonexistent token give the SAME error: there is no
        // need to tell anyone which of the three they got right.
        return c.json({ error: "Invalid or expired link" }, 401);
      }

      setCookie(c, SESSION_COOKIE, result.sessionToken, {
        httpOnly: true, // out of reach of any JS on the page
        // Key in a variable: `bun build` freezes `process.env.NODE_ENV` literally at
        // compile time (see apps/api/src/lib/entorno.ts).
        secure: process.env[ENV_VARS] === "production",
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 60,
      });

      return c.json({ data: publicMember(result.member) });
    }
  );

  /** State of the current reader: who they are and what level they have. */
  app.get(
    "/me",
    {
      id: "get-reader",
      summary: "Read the current reader",
      description:
        "The reader of the member session cookie (or `data: null` without one): public profile, access level and the highest tier that level reaches. Public.",
      access: "public",
      output: {
        schema: z
          .object({
            data: PublicMember.nullable(),
            level: z.number().optional(),
            tier: Row.nullable().optional(),
          })
          .passthrough(),
      },
      mcp: { exclude: "Reads the reader session cookie of a browser; an agent has none" },
    },
    async (c) => {
      const member = await viewerFrom(c);
      if (!member) return c.json({ data: null });

      // In series: one connection, one query at a time (SDK rule).
      const [grants, tiers] = await asSystem(
        async () => [await loadGrants(db, member.id), await loadTiers(db)] as const
      );
      const level = viewerLevel({ memberId: member.id, grants }, tiers, new Date());

      return c.json({
        data: publicMember(member),
        level,
        tier: tiers.filter((t: { level: number }) => t.level <= level).at(-1) ?? null,
      });
    }
  );

  app.post(
    "/signout",
    {
      id: "sign-out-reader",
      summary: "Close the reader session",
      description:
        "Revokes the member session of the cookie (if any) and deletes the cookie. Always `{ ok: true }`. Public.",
      access: "public",
      idempotent: true,
      output: { schema: Done },
      mcp: { exclude: "Closes the reader session cookie of a browser; an agent has none" },
    },
    async (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) await asSystem(() => revokeSession(db, token));
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    }
  );

  /**
   * Can the current reader see content with these requirements?
   *
   * Called by any kon (blog, academy, downloads) to decide. The decision lives
   * in `members.access.ts`, pure and tested.
   */
  app.post(
    "/gate",
    {
      id: "check-access",
      summary: "Check whether the current reader may see a content",
      description:
        "Given a content's requirements (`visibility`: public | members | paid, and an optional `minTierLevel`), answers whether the reader of the member cookie may see it, with the reason when not. Changes nothing. Public.",
      access: "public",
      readOnly: true,
      input: { body: GateCheck },
      output: { schema: z.object({ data: Obj }) },
    },
    async (c, { body: bodyValue }) => {
      const gate = bodyValue as ContentGate;
      const member = await viewerFrom(c);

      const tiers = await loadTiers(db);
      const viewer = member
        ? { memberId: member.id, grants: await asSystem(() => loadGrants(db, member.id)) }
        : null;

      return c.json({ data: canAccess(gate, viewer, tiers) });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Backoffice — requires a CMS session
  // ═══════════════════════════════════════════════════════════════════════════

  app.get(
    "/admin/members",
    {
      id: "list-members",
      summary: "List members (backoffice)",
      description:
        "All members, newest first, 50 per page (`page`). It is the business e-mail base: site staff (admin/editor) or an agent with members:* / member:view.",
      access: "session",
      permission: onMembers("view"),
      input: {
        query: z
          .object({ page: z.string().optional().describe("Page number (1 by default)") })
          .passthrough(),
      },
      output: { schema: Obj },
    },
    async (c, _input, h) => {
      if (!(await h.can({ id: "*" }))) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const page = Number(c.req.query("page")) || 1;
      return c.json(await repo(members, { db }).orderBy("-createdAt").paginate(page, 50));
    }
  );

  app.get(
    "/admin/members/:id",
    {
      id: "get-member",
      summary: "Read a member (backoffice)",
      description:
        "The full member record (internal notes included) and its access grants. Site staff, or the CMS account linked to that member; anyone else gets 404.",
      access: "session",
      permission: onMembers("view"),
      input: { params: ParamId },
      output: { schema: z.object({ data: Row, grants: z.array(Obj) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const member = await repo(members, { db }).find(c.req.param("id"));
      if (!member || !(await h.can(member))) {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ data: member, grants: await loadGrants(db, member.id) });
    }
  );

  app.post(
    "/admin/tiers",
    {
      id: "create-plan",
      summary: "Create a membership tier",
      description:
        "Creates a tier (slug, name, level 0-100, prices in cents, benefits). Pricing configuration: site admin, or an agent with members:* / member-tier:create. 409 if the slug exists.",
      access: "session",
      permission: { policy: { resource: "member-tier", action: "create", inHandler: true } },
      input: { body: CreateTier },
      output: { status: 201, schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, { body: bodyValue }, h) => {
      // The policy is checked after validating the body, as before the SDK.
      if (!(await h.can({}))) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const tier = await repo(memberTiers, { db }).create(bodyValue);
      return c.json({ data: tier }, 201);
    }
  );

  /** Gifts access. It is recorded as `comp`, never as a fake payment. */
  app.post(
    "/admin/access/comp",
    {
      id: "gift-access",
      summary: "Grant complimentary access to a member",
      description:
        "Gives a member access to a tier as `comp` (never as a fake payment), optionally until `endsAt`, and marks the member as comped. Site staff, or an agent with members:* / member:update. 409 if the member or the tier does not exist.",
      access: "session",
      permission: onMembers("update"),
      input: { body: CompAccess },
      output: { schema: Done },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, { body: bodyValue }, h) => {
      // The policy is checked after validating the body, as before the SDK.
      if (!(await h.can({ id: "*" }))) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const { memberId, tierId, endsAt } = bodyValue as z.infer<typeof CompAccess>;
      await compAccess(db, { memberId, tierId, endsAt: endsAt ? new Date(endsAt) : null });
      return c.json({ ok: true });
    }
  );

  app.post(
    "/admin/access/revoke",
    {
      id: "revoke-access",
      summary: "Revoke a member's access to a tier",
      description:
        "Revokes every live grant of the member for that tier (the rows stay, with `revokedAt`, as history). Both `memberId` and `tierId` are required (400 otherwise). Site staff, or an agent with members:* / member:update.",
      access: "session",
      // The policy BEFORE reading the body, as before the SDK (403 before 400).
      permission: { policy: { resource: "member", action: "update" } },
      sensitive: true,
      idempotent: true,
      input: { body: RevokeAccess },
      output: { schema: Done },
    },
    async (c, { body: bodyValue }) => {
      const body = (bodyValue ?? {}) as { memberId?: string; tierId?: string };
      if (!body.memberId || !body.tierId) {
        return c.json({ error: "memberId and tierId are required" }, 400);
      }
      await revokeAccess(db, body.memberId, body.tierId);
      return c.json({ ok: true });
    }
  );

  return app.ops;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Projection of a member for the PORTAL.
 *
 * Leaves out `note` (internal team notes about that person), `source` and
 * `labels`: they are management data, and returning them in `/me` would put
 * them one `curl` away from their own subject.
 */
function publicMember(member: Member) {
  return {
    id: member.id,
    email: member.email,
    name: member.name,
    status: member.status,
    newsletterSubscribed: member.newsletterSubscribed,
    createdAt: member.createdAt,
  };
}
