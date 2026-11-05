/**
 * Common schemas of the academy operations (parameters and outputs)
 * ============================================================================
 *
 * The bodies live next to their route (they are the usual ones). Here, what
 * repeats: the path parameters and the output shapes.
 *
 * Path ids are declared as text: academy ids are text
 * (not uuid) and one that does not exist is the handler's 404, not a 422.
 *
 * Outputs are loose on purpose (`passthrough`): they are database rows that
 * grow column by column. What a client needs to continue is fixed: the
 * id, the list, the total.
 */
import { z } from "zod";

const id = (that: string) => z.string().describe(that);

export const ParamId = (that: string) => z.object({ id: id(that) });
export const CourseParam = z.object({ courseId: id("Course id") });
export const PathAndCourseParam = z.object({
  id: id("Learning path id"),
  courseId: id("Course id inside the learning path"),
});
export const GroupAndUserParam = z.object({
  id: id("Group id"),
  userId: id("User id of the member"),
});
export const GroupAndSupervisorParam = z.object({
  id: id("Group id"),
  supervisorId: id("User id of the extra supervisor"),
});
export const CodeParam = z.object({
  code: z.string().describe("Certificate code (CERT-XXXXXXXX-XXXXXXXX-XXXXXXXXXXXX)"),
});

/** A database row: it carries `id`, and the rest as is. */
export const Row = z.object({ id: z.string() }).passthrough();
export const Rows = z.array(Row);
/** Any object (reports, metrics, results of a service). */
export const Obj = z.record(z.string(), z.unknown());

/** `{ success: true, message }` for writes that do not return the row. */
export const Done = z.object({ success: z.literal(true), message: z.string() }).passthrough();

/** `{ success: true, <key>: row }` for those that do return it. */
export const withRow = (key: string) =>
  z.object({ success: z.literal(true), [key]: Row }).passthrough();

/** `{ <key>: [rows], total }` for listings. */
export const listing = (key: string, row: z.ZodTypeAny = Row) =>
  z.object({ [key]: z.array(row), total: z.number() }).passthrough();

/** Free-text query: whatever is not declared is ignored, as always. */
export const query = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
export const text = (that: string) => z.string().optional().describe(that);

/** The spreadsheets that are downloaded. */
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
