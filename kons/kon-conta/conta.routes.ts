/**
 * Conta Kon — general ledger routes.
 * ============================================================================
 *
 * Security (an earlier audit). Before: `requireAuth` and nothing else — any account,
 * and sign-up is public, read and wrote the entire accounting —, `messageOf(err)`
 * to the client (Postgres text included), POSTED journals that
 * could be edited or deleted (account balances ended up unbalanced with no
 * trace) and template formulas executed with `new Function`.
 *
 * Now, in this order, for EVERY route except `GET /`:
 *   1. session (`access: "session"`)                    → 401
 *   2. the request's RLS context (from the host)       → the database filters too
 *   3. conta role (`conta_permissions`) + "conta" policy with `can()`:
 *        GET → view · write → write · permissions/seed → administer → 403
 *   4. body validated with an allowlist (a field that is not in the schema is
 *      a 422, not ignored)
 *   5. errors: business ones (`AccountingError`) with their message; the rest,
 *      generic (http-errors.ts).
 *
 * It is a single ledger: there are no rows "of another user", so there is no IDOR between
 * accounting users — what has to be prevented is entry by someone who is not one —.
 *
 * Each route is now an OPERATION of the kon SDK (operations.ts):
 * each handler's body is the old one; what used to be middlewares
 * (`requireAuth`, the conta role, `authorize`, `adminOnly`, `validateRequest`)
 * is now its declaration (`conta(action, …)`). Steps 1–4 remain in the
 * same order and with the same responses: the role and the policy are checked by the
 * `before` of each operation (403 "You do not have access to accounting", and an agent's
 * `!conta:<action>` denial wins, as in `can()`), and an
 * empty body or one that is not JSON is still a 400 "Invalid or missing JSON body"
 * AFTER the 403, not a 422.
 */

import {
  AppError,
  ErrorCode,
  agentCanInKon,
  can,
  respondError,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import { denialThatCovers, operationFineScope, type KonContext } from "@kitsuden/shared";
import { eq, desc, and, asc, count, gte, inArray, lte, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

import {
  accounts,
  counterparties,
  journals,
  ledgerEntries,
  projects,
  disbursements,
  journalTypeEnum,
  journalTemplates,
  currencies,
  contaPermissions,
  BILLING_TYPES,
  CONTA_ROLES,
  type Account,
  type Counterparty,
  type Project,
  type Journal,
  type Disbursement,
  type ContaRole,
} from "./conta.schema";
import { registerBillingOperations } from "./conta.billing.routes";
import { registerContaPolicy, type ContaResource } from "./conta.policy";
import {
  ContaService,
  AccountingError,
  validateLedgerLines,
  applyJournalTemplate,
  d,
  toDb,
} from "./conta.service";
import { respondWithError } from "./http-errors";
import { KON_ID, CONTA_PERMISSION, registry, type ContaAction, type Declaration } from "./operations";
import type { ContaDb } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Schemas (allowlist: everything not here is a 422)
// ═══════════════════════════════════════════════════════════════════════════

const id = z.string().min(1).max(64);
/** Amount as text, as the database stores it (numeric 19,4). */
const amount = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, "Invalid amount");
const signedAmount = z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/, "Invalid amount");
const rate = z.string().regex(/^\d{1,9}(\.\d{1,10})?$/, "Invalid exchange rate");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const metadata = z.record(z.string(), z.unknown());
const text = (max: number) => z.string().max(max);

const currencySchema = z.object({
  code: z.string().regex(/^[A-Z]{3}$/),
  name: text(100).min(1),
  symbol: text(10).min(1),
  decimalPlaces: z.number().int().min(0).max(8).default(2),
});

const accountSchema = z.object({
  code: text(50).min(1),
  name: text(255).min(1),
  description: text(2000).optional(),
  type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  parentAccountId: id.optional(),
  openingBalance: signedAmount.default("0"),
  isActive: z.boolean().default(true),
  isClientFundsAccount: z.boolean().default(false),
  level: z.number().int().min(1).max(20).optional(),
});

const counterpartySchema = z.object({
  name: text(255).min(1),
  email: z.string().email().max(255).optional(),
  taxId: text(64).optional(),
  type: z.enum(["client", "vendor", "bank", "other"]),
  contactName: text(255).optional().describe("Who to talk to at the client"),
  paymentTermsDays: z.number().int().min(0).max(3650).optional().describe("Days to pay. The default in settings otherwise"),
  fundsMinimum: amount.optional().describe("Funds balance below which the client is asked to top up"),
  externalRef: text(128).min(1).optional().describe("Its id in another system, such as a CRM"),
});

const projectSchema = z.object({
  clientId: id,
  number: text(100).min(1),
  name: text(255).min(1),
  description: text(2000).optional(),
  status: z.enum(["open", "closed", "on_hold"]).optional(),
  externalRef: text(128).min(1).optional().describe("Its id in another system, such as a CRM deal id"),
  billingType: z.enum(BILLING_TYPES).optional().describe("How it is billed: time, fixed, recurring or success. Time by default"),
  category: text(100).optional().describe("Category, for reports"),
  responsibleResourceId: id.optional().describe("Resource who runs it, from list-resources"),
});

const ledgerLineSchema = z.object({
  accountId: id,
  projectId: id.optional(),
  description: text(1000).optional(),
  debit: amount.default("0"),
  credit: amount.default("0"),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  exchangeRate: rate.default("1"),
  metadata: metadata.optional(),
});

const linesValue = z.array(ledgerLineSchema).min(2, "At least two ledger lines are required").max(500);

const journalSchema = z.object({
  date: date,
  description: text(2000).min(1),
  reference: text(255).optional(),
  counterpartyId: id.optional(),
  journalType: z
    .enum(["standard", "client_funds_deposit", "client_funds_disbursement", "disbursement", "disbursement_billed"])
    .optional(),
  templateId: id.optional(),
  metadata: metadata.optional(),
  // not `reversed`: a journal is reversed with /reverse, which generates the
  // counter-entry. Creating it already "reversed" left a journal without a counterpart.
  status: z.enum(["draft", "posted"]).optional(),
  lines: linesValue,
});

/** Only header and lines of a DRAFT; the state changes through /post and /reverse. */
const patchJournalSchema = z.object({
  date: date.optional(),
  description: text(2000).min(1).optional(),
  reference: text(255).optional(),
  counterpartyId: id.optional(),
  journalType: journalSchema.shape.journalType,
  metadata: metadata.optional(),
  lines: linesValue.optional(),
});

const templateSchema = z.object({
  name: text(255).min(1),
  description: text(2000).optional(),
  templateType: text(100).min(1),
  rules: z
    .array(
      z.object({
        accountCode: text(50).min(1),
        side: z.enum(["debit", "credit"]),
        amountFormula: text(500).min(1),
        description: text(1000).optional(),
      })
    )
    .max(100),
  requiredMetadata: z.array(text(100)).max(50).default([]),
});

const applyTemplateSchema = z.object({
  variables: z.record(z.string(), z.union([z.string().max(64), z.number()])).default({}),
  metadata: metadata.default({}),
});

const disbursementSchema = z.object({
  projectId: id,
  description: text(2000).min(1),
  amount: amount,
  paidFromAccountId: id,
  metadata: metadata.optional(),
  date: date.optional().describe("Day it was paid. Today by default"),
  category: text(100).optional().describe("Kind of expense, such as travel"),
  externalRef: text(128).min(1).optional().describe("Its id in another system"),
});

const reverseSchema = z.object({ date: date.optional() });

const permissionSchema = z.object({ role: z.enum(CONTA_ROLES) });

const patchAccountSchema = accountSchema
  .omit({ openingBalance: true })
  .partial()
  .extend({ isActive: z.boolean().optional(), isClientFundsAccount: z.boolean().optional() });
const patchCounterpartySchema = counterpartySchema.partial();
const patchProjectSchema = projectSchema.partial();
const patchTemplateSchema = templateSchema.partial();

// ── Parameters, query and outputs of the operations ─────────────────────────
//
// Ids are text (cuid): they are not validated here, an id that does not exist is the 404
// of the handler, as before. The query is optional text with no allowlist (unknown
// keys were ignored and still are); the values are
// checked by the handler with its usual 400s.

const ParamId = z.object({ id: z.string() });
const ParamUserId = z.object({ userId: z.string() });
const ParamAccountId = z.object({ accountId: z.string() });
const query = <K extends string>(...keys: K[]) =>
  z
    .object(
      Object.fromEntries(keys.map((k) => [k, z.string().optional()])) as Record<
        K,
        z.ZodOptional<z.ZodString>
      >
    )
    .passthrough();

const Row = z.object({ id: z.string() }).passthrough();
const WithRow = z.object({ data: Row }).passthrough();
const WithRows = z.object({ data: z.array(Row) }).passthrough();
const WithData = z.object({ data: z.record(z.string(), z.unknown()) }).passthrough();
const Done = z.object({ success: z.boolean() }).passthrough();
const PermissionRow = z.object({ userId: z.string(), role: z.string() }).passthrough();
const CurrencyRow = z.object({ code: z.string() }).passthrough();
/** An amount: decimal text (Postgres numeric or `Decimal.toString()`). */
const Amount = z.string();

// ═══════════════════════════════════════════════════════════════════════════
// Authorization
// ═══════════════════════════════════════════════════════════════════════════

interface SessionUser {
  id?: string;
  role?: string;
  scopes?: string[];
}

function statusToError(e: AccountingError): AppError {
  if (e.status === 404) return AppError.notFound(e.message);
  if (e.status === 409) return AppError.conflict(e.message);
  return new AppError(ErrorCode.BAD_REQUEST, e.message);
}

/**
 * JSON body as `validateRequest` read it: empty or malformed is a 400
 * "Invalid or missing JSON body" (the SDK, alone, would give a 422 for an empty
 * body). It goes AFTER authorization: a 403 does not wait for a 400. The text
 * stays in Hono's cache and the SDK reads it again from there.
 */
const jsonBodyAsBefore: MiddlewareHandler = async (c, next) => {
  const rawValue = await c.req.text();
  try {
    JSON.parse(rawValue);
  } catch {
    throw AppError.badRequest("Invalid or missing JSON body");
  }
  await next();
};

// ═══════════════════════════════════════════════════════════════════════════
// Operations
// ═══════════════════════════════════════════════════════════════════════════

export function contaOperations(ctx: KonContext): AnyOperation[] {
  registerContaPolicy();
  const app = registry();
  // The request's RLS transaction is opened by the host; `ctx.db.instance`
  // resolves to it inside each route (before: its own `rls-context.ts`).
  const db = ctx.db.instance as ContaDb;
  const service = new ContaService(db);

  /**
   * The caller's conta role (their own row; RLS lets them see only that one). It is
   * stored as before in `c.get("conta")` and, in addition, on the user
   * (`contaRole`): the operation's declared permission is checked with an empty
   * resource and the policy reads it from there. It is ALWAYS OVERWRITTEN: whatever
   * the user brought never counts.
   */
  const withContaRole: MiddlewareHandler = async (c, next) => {
    const user = c.get("user" as never) as SessionUser | null;
    if (!user?.id) throw AppError.unauthenticated();
    const [row] = await db
      .select({ role: contaPermissions.role })
      .from(contaPermissions)
      .where(eq(contaPermissions.userId, String(user.id)))
      .limit(1);
    const resource: ContaResource = { contaRole: (row?.role as ContaRole | undefined) ?? null };
    c.set("conta" as never, resource as never);
    c.set("user" as never, { ...user, contaRole: resource.contaRole } as never);
    await next();
  };

  async function authorize(c: Context, action: ContaAction, operationId?: string): Promise<void> {
    const user = (c.get("user" as never) as AuthzUser | null) ?? null;
    const resource = c.get("conta" as never) as ContaResource;
    if (await can(user, action, resource, "conta")) return;
    if (operationId && grantedByFineScope(user, action, operationId)) return;
    throw AppError.forbidden("You do not have access to accounting");
  }

  /**
   * The operation's fine scope (`kon:conta:<operation>`) grants it, as it does in every kon: an
   * agent with only `kon:conta:list-accounts` may list accounts. A denial still wins: of the
   * scope, of the whole kon (`!conta:*`) or of the action (`!conta:write`). Row security accepts
   * the same scopes (`conta_agent_can`, migrations/0008_fine_scopes_in_rls.sql).
   */
  function grantedByFineScope(user: AuthzUser | null, action: ContaAction, operationId: string): boolean {
    const scopes = Array.isArray(user?.scopes) ? (user.scopes as string[]) : [];
    if (denialThatCovers(scopes, [`conta:${action}`])) return false;
    return agentCanInKon(user, "conta", operationFineScope(KON_ID, operationId));
  }

  /**
   * The actions, in the old order: the method's (GET → view, write →
   * write, POSTs that only calculate → view) and, for the admin ones, in addition
   * `administer` (it was `adminOnly`). With the same message and with the agent's
   * denial (`!conta:write`) winning, because it is the same `can()`.
   */
  const authorizeAsBefore =
    (actions: ContaAction[], operationId: string): MiddlewareHandler =>
    async (c, next) => {
      for (const action of actions) await authorize(c, action, operationId);
      await next();
    };

  /**
   * A ledger operation: session, conta role, the policy's actions and
   * (if it carries a body) the JSON read as before. `permission` is the last action:
   * the one OpenAPI/MCP publishes and the one the SDK checks again.
   */
  const conta = (
    actions: ContaAction | ContaAction[],
    declaration: Omit<Declaration, "access" | "permission" | "before">
  ): Declaration => {
    const list = Array.isArray(actions) ? actions : [actions];
    return {
      ...declaration,
      access: "session",
      permission: CONTA_PERMISSION[list[list.length - 1]!],
      before: [
        withContaRole,
        authorizeAsBefore(list, declaration.id),
        ...(declaration.input?.body ? [jsonBodyAsBefore] : []),
      ],
    };
  };

  // ── Info (public: only the route list, no data) ─────────────────────────
  app.get(
    "/",
    {
      id: "get-info",
      summary: "Accounting kon info",
      description:
        "Public: the kon's name and a one-line description. No ledger data. Anyone may call it.",
      access: "public",
      output: {
        schema: z.object({ name: z.string(), description: z.string() }).passthrough(),
      },
    },
    (c) =>
      c.json({
        name: "Conta",
        description: "General Ledger Engine for Kitsuden",
      })
  );

  // ── Accounting role permissions (admin only) ────────────────────────────
  app.get(
    "/permissions",
    conta(["view", "administer"], {
      id: "list-permissions",
      summary: "List accounting roles",
      description:
        "Lists who holds an accounting role (`accountant`: reads and writes; `viewer`: read only), one row per user id. Admin only.",
      output: { schema: z.object({ data: z.array(PermissionRow) }).passthrough() },
    }),
    async (c) => {
      const data = await db.select().from(contaPermissions).orderBy(contaPermissions.userId);
      return c.json({ data });
    }
  );

  app.put(
    "/permissions/:userId",
    conta(["write", "administer"], {
      id: "grant-permission",
      summary: "Grant an accounting role",
      description:
        "Grants or changes a user's accounting role (`accountant` or `viewer`); repeating it leaves the same role. Returns the permission row. Admin only.",
      sensitive: true,
      input: { params: ParamUserId, body: permissionSchema },
      output: { schema: z.object({ data: PermissionRow }).passthrough() },
    }),
    async (c, input) => {
      const { role } = input.body as z.infer<typeof permissionSchema>;
      const userId = c.req.param("userId")!;
      if (userId.length > 128) throw AppError.badRequest("Invalid userId");
      const who = (c.get("user" as never) as SessionUser).id ?? null;
      const [row] = await db
        .insert(contaPermissions)
        .values({ userId, role, grantedBy: who })
        .onConflictDoUpdate({
          target: contaPermissions.userId,
          set: { role, grantedBy: who, updatedAt: new Date() },
        })
        .returning();
      await service.recordAudit({
        action: "permission.granted",
        entityType: "user",
        entityId: userId,
        summary: `Accounting role ${role}`,
      });
      return c.json({ data: row });
    }
  );

  app.delete(
    "/permissions/:userId",
    conta(["write", "administer"], {
      id: "revoke-permission",
      summary: "Revoke an accounting role",
      description:
        "Removes a user's accounting role: they lose access to the ledger. 404 if they had none. Admin only.",
      input: { params: ParamUserId },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [row] = await db
        .delete(contaPermissions)
        .where(eq(contaPermissions.userId, c.req.param("userId")!))
        .returning();
      if (!row) throw AppError.notFound("Permission not found");
      await service.recordAudit({
        action: "permission.revoked",
        entityType: "user",
        entityId: row.userId,
        summary: `Accounting role ${row.role} revoked`,
      });
      return c.json({ success: true });
    }
  );

  /** Who I am in conta: so the panel knows which buttons to show. */
  app.get(
    "/me",
    conta("view", {
      id: "get-my-role",
      summary: "My accounting role",
      description:
        "Your role in the accounting kon: `admin`, `accountant` or `viewer` (null for an agent let in by scope). Needs read access to the ledger.",
      output: {
        schema: z.object({ data: z.object({ role: z.string().nullable() }) }).passthrough(),
      },
    }),
    (c) => {
      const resource = c.get("conta" as never) as ContaResource;
      const user = c.get("user" as never) as SessionUser;
      return c.json({ data: { role: user.role === "admin" ? "admin" : resource.contaRole } });
    }
  );

  // ── Currencies ──────────────────────────────────────────────────────────
  app.get(
    "/currencies",
    conta("view", {
      id: "list-currencies",
      summary: "List currencies",
      description:
        "Lists the active currencies (code, name, symbol, decimal places). Accounting role `accountant`/`viewer`, admin, or an agent with conta:view.",
      output: { schema: z.object({ data: z.array(CurrencyRow) }).passthrough() },
    }),
    async (c) => {
      const data = await db.select().from(currencies).where(eq(currencies.isActive, true));
      return c.json({ data });
    }
  );

  app.post(
    "/currencies",
    conta("write", {
      id: "create-currency",
      summary: "Create a currency",
      description:
        "Adds a currency by ISO code (three capital letters). 409 if the code exists. Returns the new row. Accounting role `accountant`, admin, or an agent with conta:write.",
      input: { body: currencySchema },
      output: { status: 201, schema: z.object({ data: CurrencyRow }).passthrough() },
      errors: ["KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof currencySchema>;
      const [curr] = await db.insert(currencies).values(body).returning();
      return c.json({ data: curr }, 201);
    }
  );

  // ── Accounts ────────────────────────────────────────────────────────────
  app.get(
    "/accounts",
    conta("view", {
      id: "list-accounts",
      summary: "List accounts",
      description:
        "The active chart of accounts ordered by code, optionally filtered by `type` (asset, liability, equity, revenue, expense) and `isClientFunds` (true/false); `limit` 1–1000 (500 by default). Read access to the ledger.",
      input: { query: query("type", "isClientFunds", "limit") },
      output: { schema: WithRows },
    }),
    async (c) => {
      const type = c.req.query("type");
      const isClientFunds = c.req.query("isClientFunds");
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 500, 1), 1000);

      const conditions: SQL[] = [eq(accounts.isActive, true)];
      if (type) {
        const t = accountSchema.shape.type.safeParse(type);
        if (!t.success) throw AppError.badRequest("Invalid type");
        conditions.push(eq(accounts.type, t.data as Account["type"]));
      }
      if (isClientFunds) conditions.push(eq(accounts.isClientFundsAccount, isClientFunds === "true"));

      const data = await db
        .select()
        .from(accounts)
        .where(and(...conditions))
        .orderBy(accounts.code)
        .limit(limit);
      return c.json({ data });
    }
  );

  app.get(
    "/accounts/:id",
    conta("view", {
      id: "get-account",
      summary: "Account detail",
      description:
        "One account with its opening and current balance. 404 if it does not exist. Read access to the ledger.",
      input: { params: ParamId },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, c.req.param("id")!))
        .limit(1);
      if (!account) throw AppError.notFound("Account not found");
      return c.json({ data: account });
    }
  );

  app.post(
    "/accounts",
    conta("write", {
      id: "create-account",
      summary: "Create an account",
      description:
        "Adds an account to the chart. A non-zero `openingBalance` is booked as a posted journal against equity (account 3000, from the seed), not copied into the balance. 409 if the code exists. Returns the account with its balance. Write access to the ledger.",
      input: { body: accountSchema },
      output: { status: 201, schema: WithRow },
      errors: ["KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof accountSchema>;
      // The opening balance enters through a JOURNAL against equity, not
      // copied into `currentBalance` with no trace (an earlier audit).
      const [account] = await db
        .insert(accounts)
        .values({
          ...body,
          // The journal below carries it. Keeping it here too made every report count it twice.
          openingBalance: "0",
          currentBalance: "0",
          updatedAt: new Date(),
        })
        .returning();
      if (body.openingBalance && Number(body.openingBalance) !== 0) {
        try {
          await service.openWithBalance(account.id, body.openingBalance);
        } catch (err) {
          if (err instanceof AccountingError) throw AppError.validation(err.message);
          throw err;
        }
      }
      const [withBalance] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, account.id))
        .limit(1);
      return c.json({ data: withBalance ?? account }, 201);
    }
  );

  // `openingBalance` is no longer changed by PATCH: it moved the opening balance without
  // touching the current balance or leaving a journal — a silent imbalance.
  app.patch(
    "/accounts/:id",
    conta("write", {
      id: "update-account",
      summary: "Edit an account",
      description:
        "Changes an account's code, name, description, type, parent, level or flags. The opening balance cannot be changed here. 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId, body: patchAccountSchema },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof patchAccountSchema>;
      const [account] = await db
        .update(accounts)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(accounts.id, c.req.param("id")!))
        .returning();
      if (!account) throw AppError.notFound("Account not found");
      return c.json({ data: account });
    }
  );

  app.delete(
    "/accounts/:id",
    conta("write", {
      id: "deactivate-account",
      summary: "Deactivate an account",
      description:
        "Deactivates an account (it stays in the ledger and its journals; it just stops being listed). 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [account] = await db
        .update(accounts)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(accounts.id, c.req.param("id")!))
        .returning();
      if (!account) throw AppError.notFound("Account not found");
      return c.json({ success: true });
    }
  );

  // ── Counterparties ──────────────────────────────────────────────────────
  app.get(
    "/counterparties",
    conta("view", {
      id: "list-counterparties",
      summary: "List counterparties",
      description:
        "Clients, vendors, banks and others ordered by name, optionally filtered by `type` (client, vendor, bank, other) and `externalRef` (its id in another system); `limit` 1–500 (100 by default). Read access to the ledger.",
      input: { query: query("type", "externalRef", "limit") },
      output: { schema: WithRows },
    }),
    async (c) => {
      const type = c.req.query("type");
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
      const conditions: SQL[] = [];
      if (type) {
        const t = counterpartySchema.shape.type.safeParse(type);
        if (!t.success) throw AppError.badRequest("Invalid type");
        conditions.push(eq(counterparties.type, t.data as Counterparty["type"]));
      }
      const externalRef = c.req.query("externalRef");
      if (externalRef) conditions.push(eq(counterparties.externalRef, externalRef));
      const data = await db
        .select()
        .from(counterparties)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(counterparties.name)
        .limit(limit);
      return c.json({ data });
    }
  );

  app.get(
    "/counterparties/:id",
    conta("view", {
      id: "get-counterparty",
      summary: "Counterparty detail",
      description: "One counterparty. 404 if it does not exist. Read access to the ledger.",
      input: { params: ParamId },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [cp] = await db
        .select()
        .from(counterparties)
        .where(eq(counterparties.id, c.req.param("id")!))
        .limit(1);
      if (!cp) throw AppError.notFound("Counterparty not found");
      return c.json({ data: cp });
    }
  );

  app.post(
    "/counterparties",
    conta("write", {
      id: "create-counterparty",
      summary: "Create a counterparty",
      description:
        "Adds a client, vendor, bank or other counterparty (name, type, optional email and tax id). Returns the new row. Write access to the ledger.",
      input: { body: counterpartySchema },
      output: { status: 201, schema: WithRow },
      errors: ["KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof counterpartySchema>;
      const [cp] = await db
        .insert(counterparties)
        .values({ ...body, updatedAt: new Date() })
        .returning();
      return c.json({ data: cp }, 201);
    }
  );

  app.patch(
    "/counterparties/:id",
    conta("write", {
      id: "update-counterparty",
      summary: "Edit a counterparty",
      description:
        "Changes a counterparty's name, email, tax id or type. 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId, body: patchCounterpartySchema },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof patchCounterpartySchema>;
      const [cp] = await db
        .update(counterparties)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(counterparties.id, c.req.param("id")!))
        .returning();
      if (!cp) throw AppError.notFound("Counterparty not found");
      return c.json({ data: cp });
    }
  );

  app.delete(
    "/counterparties/:id",
    conta("write", {
      id: "delete-counterparty",
      summary: "Delete a counterparty",
      description:
        "Deletes a counterparty. 400 if journals or projects still reference it; 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [cp] = await db
        .delete(counterparties)
        .where(eq(counterparties.id, c.req.param("id")!))
        .returning();
      if (!cp) throw AppError.notFound("Counterparty not found");
      return c.json({ success: true });
    }
  );

  // ── Projects ─────────────────────────────────────────────────────────────
  app.get(
    "/projects",
    conta("view", {
      id: "list-projects",
      summary: "List projects",
      description:
        "Projects (jobs, cases or engagements billed to a client), newest first, optionally filtered by `clientId`, `status` (open, closed, on_hold) and `externalRef`; `limit` 1–500 (100 by default). Read access to the ledger.",
      input: { query: query("clientId", "status", "externalRef", "limit") },
      output: { schema: WithRows },
    }),
    async (c) => {
      const clientId = c.req.query("clientId");
      const status = c.req.query("status");
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);

      const conditions: SQL[] = [];
      if (clientId) conditions.push(eq(projects.clientId, clientId));
      const externalRef = c.req.query("externalRef");
      if (externalRef) conditions.push(eq(projects.externalRef, externalRef));
      if (status) {
        const s = z.enum(["open", "closed", "on_hold"]).safeParse(status);
        if (!s.success) throw AppError.badRequest("Invalid status");
        conditions.push(eq(projects.status, s.data as Project["status"]));
      }

      const data = await db
        .select()
        .from(projects)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(projects.openedAt))
        .limit(limit);
      return c.json({ data });
    }
  );

  app.get(
    "/projects/:id",
    conta("view", {
      id: "get-project",
      summary: "Project detail",
      description: "One project. 404 if it does not exist. Read access to the ledger.",
      input: { params: ParamId },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, c.req.param("id")!))
        .limit(1);
      if (!project) throw AppError.notFound("Project not found");
      return c.json({ data: project });
    }
  );

  app.post(
    "/projects",
    conta("write", {
      id: "create-project",
      summary: "Create a project",
      description:
        "Opens a project for a client counterparty (`clientId` from list-counterparties) with its number and name. 409 if the project number exists; 400 if the client does not. Returns the new row. Write access to the ledger.",
      input: { body: projectSchema },
      output: { status: 201, schema: WithRow },
      errors: ["KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof projectSchema>;
      if (body.billingType) await service.assertBillingType(body.billingType);
      const [project] = await db
        .insert(projects)
        .values({ ...body, updatedAt: new Date() })
        .returning();
      return c.json({ data: project }, 201);
    }
  );

  app.patch(
    "/projects/:id",
    conta("write", {
      id: "update-project",
      summary: "Edit a project",
      description:
        "Changes a project's client, number, name, description or status. 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId, body: patchProjectSchema },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof patchProjectSchema>;
      if (body.billingType) await service.assertBillingType(body.billingType);
      const [project] = await db
        .update(projects)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(projects.id, c.req.param("id")!))
        .returning();
      if (!project) throw AppError.notFound("Project not found");
      return c.json({ data: project });
    }
  );

  app.delete(
    "/projects/:id",
    conta("write", {
      id: "delete-project",
      summary: "Delete a project",
      description:
        "Deletes a project. 400 if ledger lines or disbursements still reference it; 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [project] = await db
        .delete(projects)
        .where(eq(projects.id, c.req.param("id")!))
        .returning();
      if (!project) throw AppError.notFound("Project not found");
      return c.json({ success: true });
    }
  );

  // ── Journal Templates ───────────────────────────────────────────────────
  app.get(
    "/templates",
    conta("view", {
      id: "list-templates",
      summary: "List journal templates",
      description:
        "Active journal templates ordered by name, optionally filtered by `type` (the template type). Read access to the ledger.",
      input: { query: query("type") },
      output: { schema: WithRows },
    }),
    async (c) => {
      const type = c.req.query("type");
      const conditions: SQL[] = [eq(journalTemplates.isActive, true)];
      if (type) conditions.push(eq(journalTemplates.templateType, type));
      const data = await db
        .select()
        .from(journalTemplates)
        .where(and(...conditions))
        .orderBy(journalTemplates.name);
      return c.json({ data });
    }
  );

  app.get(
    "/templates/:id",
    conta("view", {
      id: "get-template",
      summary: "Journal template detail",
      description:
        "One journal template with its rules (account code, side, arithmetic amount formula). 404 if it does not exist. Read access to the ledger.",
      input: { params: ParamId },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [tmpl] = await db
        .select()
        .from(journalTemplates)
        .where(eq(journalTemplates.id, c.req.param("id")!))
        .limit(1);
      if (!tmpl) throw AppError.notFound("Template not found");
      return c.json({ data: tmpl });
    }
  );

  app.post(
    "/templates",
    conta("write", {
      id: "create-template",
      summary: "Create a journal template",
      description:
        "Adds a journal template: rules that turn variables into ledger lines (`amountFormula` is plain arithmetic over the variables, never code). Returns the new row. Write access to the ledger.",
      input: { body: templateSchema },
      output: { status: 201, schema: WithRow },
      errors: ["KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof templateSchema>;
      const [tmpl] = await db
        .insert(journalTemplates)
        .values({ ...body, updatedAt: new Date() })
        .returning();
      return c.json({ data: tmpl }, 201);
    }
  );

  app.patch(
    "/templates/:id",
    conta("write", {
      id: "update-template",
      summary: "Edit a journal template",
      description:
        "Changes a journal template's name, description, type, rules or required metadata. 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId, body: patchTemplateSchema },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof patchTemplateSchema>;
      const [tmpl] = await db
        .update(journalTemplates)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(journalTemplates.id, c.req.param("id")!))
        .returning();
      if (!tmpl) throw AppError.notFound("Template not found");
      return c.json({ data: tmpl });
    }
  );

  app.delete(
    "/templates/:id",
    conta("write", {
      id: "deactivate-template",
      summary: "Deactivate a journal template",
      description:
        "Deactivates a journal template (journals made from it keep their reference). 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [tmpl] = await db
        .update(journalTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(journalTemplates.id, c.req.param("id")!))
        .returning();
      if (!tmpl) throw AppError.notFound("Template not found");
      return c.json({ success: true });
    }
  );

  // Preview a template (writes nothing)
  app.post(
    "/templates/:id/apply",
    conta("view", {
      id: "apply-template",
      summary: "Preview a journal template",
      description:
        "Computes the ledger lines a template would produce for the given variables and metadata, without writing anything (create the journal with create-journal). 404 if the template does not exist; 400 if a formula, a required metadata field or an account code fails. Read access to the ledger.",
      readOnly: true,
      input: { params: ParamId, body: applyTemplateSchema },
      output: { schema: WithData },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof applyTemplateSchema>;
      const result = await applyJournalTemplate(
        db,
        c.req.param("id")!,
        body.variables,
        body.metadata
      );
      return c.json({ data: result });
    }
  );

  // ── Journals ────────────────────────────────────────────────────────────
  app.get(
    "/journals",
    conta("view", {
      id: "list-journals",
      summary: "List journals",
      description:
        "Journal entries, newest date first, paginated (`page`, `limit` 1–200, 50 by default), optionally filtered by `status` (draft, posted, reversed), `type` (journal type), `accountId` (journals with a line on that account), `dateFrom`, `dateTo` and `q` over description and reference. Returns the headers, the pagination and `summary` over every page of the filter: `count` of journals and the `debit` and `credit` of their lines (only the lines on `accountId` when it is given). `include=lines` adds each journal's `lines`, with `accountCode` and `accountName`. Read access to the ledger.",
      input: { query: query("status", "type", "accountId", "include", "dateFrom", "dateTo", "q", "limit", "page") },
      output: {
        schema: z
          .object({
            data: z.array(Row),
            pagination: z
              .object({
                page: z.number(),
                limit: z.number(),
                total: z.number(),
                totalPages: z.number(),
              })
              .passthrough(),
          })
          .passthrough(),
      },
    }),
    async (c) => {
      const status = c.req.query("status");
      const type = c.req.query("type");
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
      const page = Math.max(Number(c.req.query("page")) || 1, 1);
      const offset = (page - 1) * limit;

      const conditions: SQL[] = [];
      if (status) {
        const s = z.enum(["draft", "posted", "reversed"]).safeParse(status);
        if (!s.success) throw AppError.badRequest("Invalid status");
        conditions.push(eq(journals.status, s.data as Journal["status"]));
      }
      if (type) {
        // Every type in the books, also those only an operation can post (`journalSchema` holds back).
        if (!(journalTypeEnum.enumValues as readonly string[]).includes(type)) {
          throw AppError.badRequest("Invalid type");
        }
        conditions.push(eq(journals.journalType, type as Journal["journalType"]));
      }
      const dateFrom = c.req.query("dateFrom");
      const dateTo = c.req.query("dateTo");
      const search = c.req.query("q");
      if (dateFrom) conditions.push(gte(journals.date, dateFrom));
      if (dateTo) conditions.push(lte(journals.date, dateTo));
      if (search) {
        const like = `%${search}%`;
        conditions.push(or(ilike(journals.description, like), ilike(journals.reference, like)) as SQL);
      }
      const accountId = c.req.query("accountId");
      if (accountId) {
        conditions.push(
          sql`EXISTS (SELECT 1 FROM ${ledgerEntries} WHERE ${ledgerEntries.journalId} = ${journals.id} AND ${ledgerEntries.accountId} = ${accountId})`
        );
      }
      const include = c.req.query("include");
      if (include && include !== "lines") throw AppError.badRequest("Invalid include");
      const where = conditions.length ? and(...conditions) : undefined;

      const data = await db
        .select()
        .from(journals)
        .where(where)
        .orderBy(desc(journals.date), desc(journals.createdAt))
        .limit(limit)
        .offset(offset);
      const [{ total }] = await db.select({ total: count() }).from(journals).where(where);
      const [sums] = await db
        .select({
          debit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)`,
          credit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)`,
        })
        .from(ledgerEntries)
        .innerJoin(journals, eq(ledgerEntries.journalId, journals.id))
        .where(and(where, accountId ? eq(ledgerEntries.accountId, accountId) : undefined));

      // The page's lines in one query, not one per journal.
      const lines =
        include === "lines" && data.length
          ? await db
              .select({ line: ledgerEntries, accountCode: accounts.code, accountName: accounts.name })
              .from(ledgerEntries)
              .innerJoin(accounts, eq(ledgerEntries.accountId, accounts.id))
              .where(inArray(ledgerEntries.journalId, data.map((j) => j.id)))
              .orderBy(desc(sql`${ledgerEntries.debit} > 0`), asc(accounts.code))
          : [];

      return c.json({
        data:
          include === "lines"
            ? data.map((journal) => ({
                ...journal,
                lines: lines
                  .filter((l) => l.line.journalId === journal.id)
                  .map((l) => ({ ...l.line, accountCode: l.accountCode, accountName: l.accountName })),
              }))
            : data,
        pagination: {
          page,
          limit,
          total: Number(total),
          totalPages: Math.ceil(Number(total) / limit),
        },
        summary: {
          count: Number(total),
          debit: toDb(d(sums?.debit ?? 0)),
          credit: toDb(d(sums?.credit ?? 0)),
        },
      });
    }
  );

  app.get(
    "/journals/:id",
    conta("view", {
      id: "get-journal",
      summary: "Journal detail",
      description:
        "One journal entry with its ledger lines (`lines`). 404 if it does not exist. Read access to the ledger.",
      input: { params: ParamId },
      output: {
        schema: z
          .object({ data: Row.extend({ lines: z.array(Row) }).passthrough() })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [entry] = await db
        .select()
        .from(journals)
        .where(eq(journals.id, c.req.param("id")!))
        .limit(1);
      if (!entry) throw AppError.notFound("Journal not found");

      const lines = await db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.journalId, entry.id));
      return c.json({ data: { ...entry, lines } });
    }
  );

  app.post(
    "/journals/validate",
    conta("view", {
      id: "validate-journal",
      summary: "Validate a journal",
      description:
        "Checks a journal without saving it: whether debits equal credits (per currency, after exchange rate) and the totals. Same body as create-journal. Read access to the ledger is enough.",
      readOnly: true,
      input: { body: journalSchema },
      output: {
        schema: z
          .object({
            valid: z.boolean(),
            totalDebits: Amount,
            totalCredits: Amount,
            errors: z.array(z.string()),
          })
          .passthrough(),
      },
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof journalSchema>;
      const result = validateLedgerLines(body.lines);
      return c.json({
        valid: result.ok,
        totalDebits: result.totalDebits.toString(),
        totalCredits: result.totalCredits.toString(),
        errors: result.errors,
      });
    }
  );

  app.post(
    "/journals",
    conta("write", {
      id: "create-journal",
      summary: "Create a journal",
      description:
        "Creates a balanced journal entry (two or more lines; debits must equal credits) as `draft` (default) or `posted` (posting moves the account balances). 400 if it does not balance or an account does not exist. Returns `{ journal, lines }`. Write access to the ledger.",
      input: { body: journalSchema },
      output: { status: 201, schema: WithData },
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof journalSchema>;
      const result = await service.createJournal(body);
      return c.json({ data: result }, 201);
    }
  );

  /** Loads a journal and requires it to still be a draft. */
  async function draft(journalId: string): Promise<Journal> {
    const [entry] = await db.select().from(journals).where(eq(journals.id, journalId)).limit(1);
    if (!entry) throw AppError.notFound("Journal not found");
    if (entry.status !== "draft") {
      // A posted journal has already moved balances: changing or deleting it
      // unbalanced the accounts with no trace. It is corrected by reversing it.
      throw AppError.conflict("Only draft journals can be modified; reverse it instead");
    }
    return entry;
  }

  app.patch(
    "/journals/:id",
    conta("write", {
      id: "update-journal",
      summary: "Edit a draft journal",
      description:
        "Changes a DRAFT journal's header and, if `lines` is sent, replaces its lines (they must balance, else 422). A posted journal is a 409: reverse it instead (reverse-journal). 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId, body: patchJournalSchema },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof patchJournalSchema>;
      const journalId = c.req.param("id")!;
      await draft(journalId);
      const { lines, ...header } = body;

      if (lines) {
        const validation = validateLedgerLines(lines);
        if (!validation.ok) {
          throw AppError.validation("Validation failed", { lines: validation.errors });
        }
      }

      const [entry] = await db
        .update(journals)
        .set({ ...header, updatedAt: new Date() })
        .where(eq(journals.id, journalId))
        .returning();

      if (lines) {
        const validation = validateLedgerLines(lines);
        await db.delete(ledgerEntries).where(eq(ledgerEntries.journalId, journalId));
        await db.insert(ledgerEntries).values(
          lines.map((line) => ({
            journalId,
            accountId: line.accountId,
            projectId: line.projectId || null,
            description: line.description || entry.description,
            debit: line.debit,
            credit: line.credit,
            currency: line.currency,
            exchangeRate: line.exchangeRate,
            metadata: line.metadata || {},
          }))
        );
        await db
          .update(journals)
          .set({ totalAmount: validation.totalDebits.toFixed(4) })
          .where(eq(journals.id, journalId));
      }

      return c.json({ data: entry });
    }
  );

  app.delete(
    "/journals/:id",
    conta("write", {
      id: "delete-journal",
      summary: "Delete a draft journal",
      description:
        "Deletes a DRAFT journal and its lines. A posted journal is a 409: reverse it instead (reverse-journal). 404 if it does not exist. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c) => {
      const journalId = c.req.param("id")!;
      await draft(journalId);
      await db.delete(journals).where(eq(journals.id, journalId));
      return c.json({ success: true });
    }
  );

  app.post(
    "/journals/:id/post",
    conta("write", {
      id: "post-journal",
      summary: "Post a draft journal",
      description:
        "Posts a draft journal: it becomes final and moves the account balances. 409 if it is already posted or reversed; 400 if it does not balance; 404 if it does not exist. Returns the journal. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c) => {
      const entry = await service.postJournal(c.req.param("id")!);
      return c.json({ data: entry });
    }
  );

  app.post(
    "/journals/:id/reverse",
    conta("write", {
      id: "reverse-journal",
      summary: "Reverse a posted journal",
      description:
        "Reverses a POSTED journal with a counter-entry dated `date` (today by default) and marks the original as reversed; only once. 409 for a draft or an already reversed journal; 404 if it does not exist. Returns `{ original, reversal }`. Write access to the ledger.",
      sensitive: true,
      input: { params: ParamId, body: reverseSchema },
      output: { schema: WithData },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof reverseSchema>;
      const result = await service.reverseJournal(c.req.param("id")!, body.date);
      return c.json({ data: result });
    }
  );

  // ── T-Account View ──────────────────────────────────────────────────────
  app.get(
    "/t-account/:accountId",
    conta("view", {
      id: "get-t-account",
      summary: "T-account view",
      description:
        "An account's posted movements with running balance, opening and closing balance, optionally between `dateFrom` and `dateTo` (YYYY-MM-DD) and filtered by `projectId` and `currency`. Amounts are decimal strings. 404 if the account does not exist. Read access to the ledger.",
      input: {
        params: ParamAccountId,
        query: query("dateFrom", "dateTo", "projectId", "currency"),
      },
      output: { schema: WithData },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const result = await service.getTAccount(c.req.param("accountId")!, {
        dateFrom: c.req.query("dateFrom") || undefined,
        dateTo: c.req.query("dateTo") || undefined,
        projectId: c.req.query("projectId") || undefined,
        currency: c.req.query("currency") || undefined,
      });
      return c.json({
        data: {
          ...result,
          openingBalance: result.openingBalance.toString(),
          closingBalance: result.closingBalance.toString(),
          movements: result.movements.map((m) => ({
            ...m,
            debit: m.debit.toString(),
            credit: m.credit.toString(),
            balance: m.balance.toString(),
          })),
        },
      });
    }
  );

  // ── Client funds balance ──────────────────────────────────────────────────────
  app.get(
    "/client-funds/balance",
    conta("view", {
      id: "get-client-funds-balance",
      summary: "Client funds account balance",
      description:
        "Balance and movements of a client funds account (`accountId`, required), optionally for one `projectId`. 400 without accountId; 404 if it is not a client funds account. Read access to the ledger.",
      input: { query: query("accountId", "projectId") },
      output: { schema: WithData },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const accountId = c.req.query("accountId");
      const projectId = c.req.query("projectId");
      if (!accountId) throw AppError.badRequest("accountId is required");

      const result = await service.getClientFundsAccountBalance(accountId, projectId || undefined);
      return c.json({
        data: {
          ...result,
          balance: result.balance.toString(),
          movements: result.movements.map((m) => ({
            ...m,
            debit: m.debit.toString(),
            credit: m.credit.toString(),
            balance: m.balance.toString(),
          })),
        },
      });
    }
  );

  // ── Disbursements ───────────────────────────────────────────────────────
  app.get(
    "/disbursements",
    conta("view", {
      id: "list-disbursements",
      summary: "List disbursements",
      description:
        "Recoverable client expenses, newest first, optionally filtered by `projectId` and `status` (pending, billed, paid); `limit` 1–200 (50 by default). Read access to the ledger.",
      input: { query: query("projectId", "status", "limit") },
      output: { schema: WithRows },
    }),
    async (c) => {
      const projectId = c.req.query("projectId");
      const status = c.req.query("status");
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);

      const conditions: SQL[] = [];
      if (projectId) conditions.push(eq(disbursements.projectId, projectId));
      if (status) {
        const s = z.enum(["pending", "billed", "paid"]).safeParse(status);
        if (!s.success) throw AppError.badRequest("Invalid status");
        conditions.push(eq(disbursements.status, s.data as Disbursement["status"]));
      }

      const data = await db
        .select()
        .from(disbursements)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(disbursements.createdAt))
        .limit(limit);
      return c.json({ data });
    }
  );

  app.get(
    "/disbursements/:id",
    conta("view", {
      id: "get-disbursement",
      summary: "Disbursement detail",
      description: "One disbursement. 404 if it does not exist. Read access to the ledger.",
      input: { params: ParamId },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    }),
    async (c) => {
      const [disb] = await db
        .select()
        .from(disbursements)
        .where(eq(disbursements.id, c.req.param("id")!))
        .limit(1);
      if (!disb) throw AppError.notFound("Disbursement not found");
      return c.json({ data: disb });
    }
  );

  app.post(
    "/disbursements",
    conta("write", {
      id: "create-disbursement",
      summary: "Record a disbursement",
      description:
        "Records an expense paid for a project: posts a journal (credit `paidFromAccountId`, debit account 1250 Disbursements Receivable, from the seed) and leaves the disbursement `pending`. 400 if an account or the project does not exist. Returns `{ disbursement, journal, lines }`. Write access to the ledger.",
      input: { body: disbursementSchema },
      output: { status: 201, schema: WithData },
    }),
    async (c, input) => {
      const body = input.body as z.infer<typeof disbursementSchema>;
      const result = await service.createDisbursement(body);
      return c.json({ data: result }, 201);
    }
  );

  app.post(
    "/disbursements/:id/bill",
    conta("write", {
      id: "bill-disbursement",
      summary: "Bill a disbursement",
      description:
        "Bills a PENDING disbursement to the client: posts the journal that moves it to accounts receivable and marks it `billed`. 409 if already billed or paid; 404 if it does not exist. Returns `{ journal, lines }`. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: WithData },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c) => {
      const result = await service.billDisbursement(c.req.param("id")!);
      return c.json({ data: result });
    }
  );

  app.post(
    "/disbursements/:id/pay",
    conta("write", {
      id: "pay-disbursement",
      summary: "Mark a disbursement paid",
      description:
        "Marks a BILLED disbursement as paid by the client. 409 if it is not billed; 404 if it does not exist. Returns the disbursement. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: WithRow },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c) => {
      const disb = await service.payDisbursement(c.req.param("id")!);
      return c.json({ data: disb });
    }
  );

  // Only a PENDING expense is deleted: a billed one already has a journal.
  app.delete(
    "/disbursements/:id",
    conta("write", {
      id: "delete-disbursement",
      summary: "Delete a pending disbursement",
      description:
        "Deletes a PENDING disbursement and reverses its journal. 404 if it does not exist or is already billed. Write access to the ledger.",
      input: { params: ParamId },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    }),
    async (c) => {
      const [disb] = await db
        .delete(disbursements)
        .where(
          and(
            eq(disbursements.id, c.req.param("id")!),
            eq(disbursements.status, "pending"),
            isNull(disbursements.invoiceId)
          )
        )
        .returning();
      if (!disb) throw AppError.notFound("Disbursement not found or already billed");
      // Its journal (already posted when it was recorded) is REVERSED: deleting only
      // the disbursement left the expense in the ledger (an earlier audit).
      if (disb.journalId) await service.reverseJournal(disb.journalId);
      return c.json({ success: true });
    }
  );

  // ── Reports ─────────────────────────────────────────────────────────────
  app.get(
    "/reports/trial-balance",
    conta("view", {
      id: "get-trial-balance",
      summary: "Trial balance",
      description:
        "Per active account: total debits, total credits and balance of posted journals, optionally between `dateFrom` and `dateTo` (YYYY-MM-DD). Amounts are decimal strings. Read access to the ledger.",
      input: { query: query("dateFrom", "dateTo") },
      output: {
        schema: z
          .object({
            data: z.array(
              z
                .object({
                  account: Row,
                  totalDebit: Amount,
                  totalCredit: Amount,
                  balance: Amount,
                })
                .passthrough()
            ),
          })
          .passthrough(),
      },
    }),
    async (c) => {
      const data = await service.getTrialBalance({
        dateFrom: c.req.query("dateFrom") || undefined,
        dateTo: c.req.query("dateTo") || undefined,
      });
      return c.json({
        data: data.map((item) => ({
          ...item,
          totalDebit: item.totalDebit.toString(),
          totalCredit: item.totalCredit.toString(),
          balance: item.balance.toString(),
        })),
      });
    }
  );

  app.get(
    "/reports/balance-sheet",
    conta("view", {
      id: "get-balance-sheet",
      summary: "Balance sheet",
      description:
        "Assets, liabilities and equity with their totals as of `asOf` (YYYY-MM-DD; today by default), plus the net income not yet closed into equity. Amounts are decimal strings. Read access to the ledger.",
      input: { query: query("asOf") },
      output: { schema: WithData },
    }),
    async (c) => {
      const data = await service.getBalanceSheet(c.req.query("asOf") || undefined);
      return c.json({
        data: {
          ...data,
          totalAssets: data.totalAssets.toString(),
          totalLiabilities: data.totalLiabilities.toString(),
          totalEquity: data.totalEquity.toString(),
          netIncome: data.netIncome.toString(),
          totalLiabilitiesAndEquity: data.totalLiabilitiesAndEquity.toString(),
          assets: data.assets.map((a) => ({ ...a, balance: a.balance.toString() })),
          liabilities: data.liabilities.map((a) => ({ ...a, balance: a.balance.toString() })),
          equity: data.equity.map((a) => ({ ...a, balance: a.balance.toString() })),
        },
      });
    }
  );

  app.get(
    "/reports/profit-loss",
    conta("view", {
      id: "get-income-statement",
      summary: "Profit and loss",
      description:
        "Revenue and expense accounts with their totals and net income, optionally between `dateFrom` and `dateTo` (YYYY-MM-DD). With `groupBy` (month or quarter; dateFrom and dateTo then required, at most 120 periods) it answers `{ periods, accounts: [{ code, name, type, amounts: { <period>: amount }, total }], totals: { income, expense, net, marginPct } }` instead, with the movement of each period and no opening balances. Amounts are decimal strings. Read access to the ledger.",
      input: { query: query("dateFrom", "dateTo", "groupBy") },
      output: { schema: WithData },
    }),
    async (c) => {
      const groupBy = c.req.query("groupBy");
      if (groupBy) {
        if (groupBy !== "month" && groupBy !== "quarter") throw AppError.badRequest("Invalid groupBy");
        const dateFrom = c.req.query("dateFrom");
        const dateTo = c.req.query("dateTo");
        if (!dateFrom || !dateTo) throw AppError.badRequest("groupBy needs dateFrom and dateTo");
        return c.json({ data: await service.getProfitAndLossByPeriod({ dateFrom, dateTo, groupBy }) });
      }
      const data = await service.getProfitAndLoss({
        dateFrom: c.req.query("dateFrom") || undefined,
        dateTo: c.req.query("dateTo") || undefined,
      });
      return c.json({
        data: {
          ...data,
          totalRevenue: data.totalRevenue.toString(),
          totalExpenses: data.totalExpenses.toString(),
          netIncome: data.netIncome.toString(),
          revenue: data.revenue.map((a) => ({ ...a, balance: a.balance.toString() })),
          expenses: data.expenses.map((a) => ({ ...a, balance: a.balance.toString() })),
        },
      });
    }
  );

  // ── Seed (admin) ────────────────────────────────────────────────────────
  app.post(
    "/seed",
    conta(["write", "administer"], {
      id: "seed-chart-of-accounts",
      summary: "Seed the default chart of accounts",
      description:
        "Creates the default currencies and chart of accounts (codes 1000…, 1250, 3000, 4000…) if missing; existing ones are left alone, so repeating it changes nothing. Admin only.",
      sensitive: true,
      idempotent: true,
      output: {
        schema: z.object({ success: z.boolean(), message: z.string() }).passthrough(),
      },
    }),
    async (c) => {
      await service.seedDefaultAccounts();
      return c.json({ success: true, message: "Default chart of accounts and currencies created" });
    }
  );

  // ── Invoices, work, client funds, recurring fees, bank, close, audit and management reports ─
  registerBillingOperations(app, conta, db);

  return app.ops;
}

// ═══════════════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The operations router, with the usual `onError`: business errors
 * (`AccountingError`) with their status and message, and everything else translated
 * without internal details (http-errors.ts). The SDK itself serves the handlers'
 * `AppError`s; what the `before` throws (401/403/400) and what is not an
 * `AppError` arrives here.
 */
export function createContaRouter(ctx: KonContext): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AccountingError) return respondError(c, statusToError(err));
    return respondWithError(err, c, "conta");
  });
  app.route("/", operationsRouter(KON_ID, contaOperations(ctx), ctx));
  return app;
}
