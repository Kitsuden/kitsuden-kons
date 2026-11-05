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
import { z } from "zod";

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
