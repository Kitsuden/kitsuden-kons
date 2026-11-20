/**
 * Common schemas of the esports operations (parameters and outputs)
 * ============================================================================
 *
 * Bodies live next to their route. Here, what is repeated: the path
 * parameters and the output shapes.
 *
 * Path ids are declared as text: `withValidatedIds` (valid-ids.ts)
 * answers 404 to one that is not a uuid BEFORE reaching the operation, so the
 * contract is "uuid, or 404" and not a 422.
 *
 * Outputs are loose on purpose (`passthrough`): they are database rows or
 * results of the engines (bracket, Swiss, check-in), which grow column by
 * column. What a client needs to continue is pinned down: the id, the list, the
 * `data` envelope.
 */
import { z } from "@kitsuden/engine/zod";

const uuid = (that: string) => z.string().describe(`${that} (uuid; anything else is a 404)`);

export const ParamId = z.object({ id: uuid("Id") });
export const TournamentParam = z.object({ id: uuid("Tournament id") });
export const ParamTournamentId = z.object({ tournamentId: uuid("Tournament id") });
export const ParamSet = z.object({ matchId: uuid("Set id (a row of esports_matches)") });
export const ParticipantParam = z.object({
  participantId: uuid("Participant id (esports_tournament_participants), NOT a player id"),
});
export const PhaseParam = z.object({ phaseId: uuid("Phase id") });
export const ParamToken = z.object({
  token: z.string().describe("Invite token from the invite link"),
});

/** A database row: it carries `id`, and the rest as is. */
export const Row = z.object({ id: z.string() }).passthrough();
export const Rows = z.array(Row);
/** Result of an engine (bracket, Swiss, phases…): an object. */
export const Obj = z.record(z.string(), z.unknown());
export const Deleted = z.object({ deleted: z.literal(true), id: z.string() });

/** `{ data: … }` and whatever comes with it. */
export const withData = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data: data }).passthrough();

/** Free-text query: whatever is not declared is ignored, as always. */
export const query = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
export const text = (that: string) => z.string().optional().describe(that);

// ── Pages (api-contract, 2026-11-18) ─────────────────────────────────────────
//
// The lists answer a bare array, so `hasMore` cannot go next to the items
// without changing the body every client reads. It goes in the `X-Has-More`
// header (`true`/`false`); without the header, a page shorter than `limit` is
// the last one.

const offset = z.coerce.number().int().min(0).default(0).describe("Rows to skip.");

/**
 * Only `offset`, for a list whose `limit` keeps its own lenient parsing (a
 * value that is not a number falls back to the default, one over the cap is
 * clamped): a strict `limit` schema would answer 422 to requests that got a
 * page before.
 */
export const pageOffset = { offset };

/**
 * `limit` and `offset` of a list that used to stop at `cap` rows with no sign.
 * The default is the old cap: a client that sends nothing gets what it always got.
 */
export const cappedPage = (cap: number) => ({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(cap)
    .default(cap)
    .describe(
      `Rows per page (1-${cap}). The default is the maximum, what the list always returned. The \`X-Has-More\` response header says whether more follow.`
    ),
  offset,
});

/** `limit` and `offset` of a list that returned everything: without `limit` it still does. */
export const optionalPage = (max: number) => ({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(
      `Rows per page (1-${max}). Without it, every row, as always. The \`X-Has-More\` response header says whether more follow.`
    ),
  offset,
});

/** The validated `limit` (absent: no page) and `offset`. */
export function pageOf(input: { query?: unknown }): { limit?: number; offset: number } {
  const q = (input.query ?? {}) as { limit?: number; offset?: number };
  return { limit: q.limit, offset: q.offset ?? 0 };
}

/**
 * Cuts the `limit + 1` rows read to the page and sets `X-Has-More`. Without
 * `limit`, every row and `false`.
 */
export function cutPage<T>(
  c: { header: (name: string, value: string) => void },
  rows: T[],
  limit: number | undefined
): T[] {
  const hasMore = limit !== undefined && rows.length > limit;
  c.header("X-Has-More", String(hasMore));
  return hasMore ? rows.slice(0, limit) : rows;
}
