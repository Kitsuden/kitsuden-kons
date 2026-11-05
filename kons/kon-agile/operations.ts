/**
 * Agile's routes as kon SDK operations
 * ============================================================================
 *
 * The router registered its handlers in a `Hono` with
 * `app.get(path, ...middlewares, handler)`. Now it registers OPERATIONS with the
 * same shape: `app.get(path, declaration, handler)`, where the declaration
 * (id, schemas, access, permission, errors) replaces the middlewares and the
 * handler is still the same —it receives the Hono context `c`—.
 *
 * This way each route's body does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, OpenAPI
 * and the fine-grained scope `kon:agile:<id>` come from.
 *
 * The two operations an agent uses through MCP (reading the board and proposing an
 * intake) remain in agile.operations.ts, written directly with
 * `defineOperation`; those in this registry do NOT go out through MCP (see `REST_ONLY`).
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "zod";

export const KON_ID = "kon-agile";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id/:userId/:key/:intakeId/:projectId";

/** A handler of the old kind, with the validated input and the operation's context. */
export type Handler = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the variables are set by the host
  c: Context<any, KonPath>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each operation brings its own schemas
  input: ValidatedInput<any, any, any>,
  h: OperationContext
) => unknown;

/**
 * The operations an agent uses through MCP besides reading the board and proposing (1.3, owner's
 * decision 2026-11-03: agents work as teammates). They are the same REST operations, with the same
 * gate: an agent writes only on issues in its reach (agile.access.ts), and the database refuses
 * the rest (migration 0005). Configuration, intake decisions and deleting stay REST-only.
 */
export const AGENT_TOOLS: Record<string, { name: string; whenToUse: string }> = {
  "list-my-work": {
    name: "agile_my_work",
    whenToUse: "First thing in a run: what you were asked to do (assignments, mentions, hand-offs, schedules).",
  },
  "claim-work": {
    name: "agile_claim_work",
    whenToUse: "Before starting a piece of work from agile_my_work, so nobody does it twice.",
  },
  "finish-work": {
    name: "agile_finish_work",
    whenToUse: "When a piece of work is done or failed: its result, run id, tokens and cost.",
  },
  "list-issues": {
    name: "agile_list_issues",
    whenToUse: "To find issues by state, assignee, label, cycle… (e.g. your own: assigneeId = your id).",
  },
  "get-issue": { name: "agile_get_issue", whenToUse: "To read one issue by its key before working on it." },
  "list-issue-comments": { name: "agile_list_comments", whenToUse: "To read the conversation on an issue." },
  "list-checklist": { name: "agile_get_checklist", whenToUse: "To see the steps of an issue." },
  "update-issue": {
    name: "agile_update_issue",
    whenToUse: "To move your issue to another state or change its fields. Only issues in your reach.",
  },
  "comment-issue": {
    name: "agile_comment",
    whenToUse: "To report progress or ask something on an issue in your reach; `mentions` notifies members.",
  },
  "update-checklist-item": {
    name: "agile_check_item",
    whenToUse: "To tick a step of the checklist of an issue in your reach.",
  },
  "add-checklist-item": { name: "agile_add_checklist_item", whenToUse: "To split your issue into steps." },
  "handoff-issue": {
    name: "agile_handoff",
    whenToUse: "To pass your issue to another member (person or agent) with a note of where it stands.",
  },
  "create-issue": {
    name: "agile_create_issue",
    whenToUse: "To create an issue assigned to yourself or, as scrum master, to your squad. Otherwise propose an intake.",
  },
  "list-squads": { name: "agile_list_squads", whenToUse: "To know your squad and who you can hand work to." },
};

/** A registry of operations shaped like a router. */
export function registry() {
  const ops: AnyOperation[] = [];
  const add =
    (method: KonOperation["method"]) =>
    (route: string, declaration: Declaration, handle: Handler): void => {
      const tool = AGENT_TOOLS[declaration.id];
      ops.push(
        defineOperation({
          ...declaration,
          ...(tool
            ? { mcp: { name: tool.name }, guide: { ...declaration.guide, whenToUse: tool.whenToUse } }
            : {}),
          method,
          route,
          handle: (input, h) => handle(h.c, input, h),
        })
      );
    };
  return {
    ops,
    get: add("GET"),
    post: add("POST"),
    put: add("PUT"),
    patch: add("PATCH"),
    delete: add("DELETE"),
  };
}

/**
 * All these routes asked for a session (`app.use("/*", requireAuth)`). People
 * all get in; an AGENT, only with the host's usual rule
 * (`agent-as-user.ts`): `user:act`, `admin` or some agile scope.
 * SDK operations do not go through that rule, so the `actAsUser`
 * action of the "agile" policy (agile.policy.ts) repeats it, checked BEFORE
 * validating, like the `requireAuth` of before. `/api/agile` has no prefix gate
 * in the host (auth-guard.ts) that does it per kon.
 *
 * What the route asked for AFTER (project membership: view / write /
 * manage, and the `agile:create-project` gate) the handler still asks
 * with `can()`, as before.
 */
export const ANY_ACCOUNT = {
  policy: { resource: "agile", action: "actAsUser" },
} as const;

/**
 * Only `agile_read_board` and `agile_submit_intake` go out through MCP
 * (agile.operations.ts): the design's write boundary is that an agent
 * READS the board and PROPOSES; writing issues and deciding intakes belongs to people
 * (or to a member agent through REST, with its permission).
 */
export const REST_ONLY = {
  exclude:
    "Agents read the board and propose intakes (agile_read_board, agile_submit_intake); the rest of the tracker is REST only",
} as const;

// ── Common schemas (parameters and outputs) ─────────────────────────────────
//
// Path ids are text: the handler answers 404 to anything that is not a uuid
// or does not exist for the asker (it does not become a 422). Outputs are
// loose (`passthrough`): database rows that grow column by column.

export const ParamId = z.object({ id: z.string().describe("Project id (uuid)") });
export const ProjectParam = z.object({ projectId: z.string().describe("Project id (uuid)") });
export const MemberParam = z.object({
  id: z.string().describe("Project id (uuid)"),
  userId: z.string().describe("User id of the member"),
});
export const KeyParam = z.object({
  key: z.string().describe("Issue key, e.g. PLAT-12 (not the uuid)"),
});
export const ParamIntake = z.object({ intakeId: z.string().describe("Intake id (uuid)") });
export const TableIntakeParam = z.object({ id: z.string().describe("Intake id (uuid)") });

/** A database row: it carries `id`, and the rest as is. */
export const Row = z.object({ id: z.string() }).passthrough();
export const ListWithTotal = z
  .object({ docs: z.array(Row), totalDocs: z.number().int() })
  .passthrough();
export const Members = z
  .object({
    docs: z.array(z.object({ userId: z.string(), role: z.string() }).passthrough()),
    totalDocs: z.number().int(),
  })
  .passthrough();
export const Success = z.object({ success: z.literal(true) });
export const ApprovedIntake = z
  .object({
    success: z.literal(true),
    issue: z.object({ id: z.string(), key: z.string().nullable(), name: z.string() }),
    intake: z.object({ id: z.string(), status: z.literal("accepted") }),
  })
  .passthrough();

/** Free-text query: whatever is not declared is ignored, as always. */
export const query = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
export const text = (that: string) => z.string().optional().describe(that);

/**
 * The declaration of a board operation in one line: a session, the "agile" account rule and
 * REST only (unless it is one of `AGENT_TOOLS`). What each one may do is decided in its handler.
 */
export function declareOp(
  id: string,
  summary: string,
  description: string,
  input: Declaration["input"],
  output: Declaration["output"] = { schema: Row },
  errors: Declaration["errors"] = ["KITSUDEN_E_NOT_FOUND"]
): Declaration {
  return { id, summary, description, access: "session", permission: ANY_ACCOUNT, mcp: REST_ONLY, input, output, errors };
}
