/**
 * No kon creates its tables at runtime
 * ============================================================================
 *
 * Tables are created with migrations. Period. A `CREATE TABLE` inside the
 * kon's code is, in production, dead code that also lies.
 *
 * ── WHY IT CANNOT WORK ─────────────────────────────────────────────────────
 *
 * The API connects as `kitsuden_app`, a role WITHOUT the CREATE privilege on the
 * schema. This is not an oversight: it is what makes Row-Level Security actually
 * apply, because Postgres skips policies for a superuser. A
 * `CREATE TABLE` from the application has to fail, and it does.
 *
 * ── AND WHY IT WAS NOT NOTICED ─────────────────────────────────────────────
 *
 * Because the helper that ran them caught the error, wrote a log line
 * and returned `false` — which nobody checked:
 *
 *     } catch (err) {
 *       ctx.logger.error(`❌ Academy: ${description} failed - ${error.message}`);
 *       return false;                    // ← and the kon kept starting
 *     }
 *
 * At real startup that was twenty-five "permission denied for schema
 * public" in a row, among hundreds of log lines, and the kon was considered
 * started. If any of those tables were NOT also in a migration —and
 * nothing guaranteed it— the kon would start without it and fail on first use.
 *
 * Academy and Booking did this. Their migrations already created the same 25 and 6
 * tables respectively, so the whole block was dead weight with
 * the capacity to confuse.
 *
 * ── WHAT IS ALLOWED ────────────────────────────────────────────────────────
 *
 * The `.sql` files in `migrations/`, obviously. And TEMPORARY tables,
 * which live in the session and do not touch the schema.
 */

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { listFiles } from "../../.kitsuden/tests/unit/helpers/files";

const ROOT = join(__dirname, "..", "..");

/**
 * Neutralizes block and line comments: a CREATE TABLE quoted in a
 * note does not count.
 *
 * They are replaced by spaces instead of being deleted, and line breaks
 * are kept. If they were deleted, the line number this test reports would
 * be that of the trimmed text and not of the file: the first version did that and
 * pointed to line 369 of a file whose CREATE TABLE is on 475 — a
 * diagnosis that sends you to read the wrong place.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (l.trimStart().startsWith("//") ? "" : l))
    .join("\n");
}

describe("kons do not create tables at runtime", () => {
  const findings: string[] = [];

  const sources = [
    ...listFiles(join(ROOT, "kons"), ".ts"),
    ...listFiles(join(ROOT, ".kitsuden", "packages", "core"), ".ts"),
  ].filter((f) => !f.includes(".test.") && !f.endsWith(".d.ts"));

  for (const file of sources) {
    const code = withoutComments(readFileSync(file, "utf-8"));

    for (const m of code.matchAll(/CREATE\s+(?:(TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE/gi)) {
      // Temporary ones live in the session: they do not need CREATE on the schema
      // and disappear on their own. They are not the problem.
      if (m[1]) continue;

      const line = code.slice(0, m.index).split("\n").length;
      findings.push(
        `${file
          .slice(ROOT.length + 1)
          .split(sep)
          .join("/")}:${line}`
      );
    }
  }

  it("kon sources were read", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it("no TypeScript source runs CREATE TABLE", () => {
    expect(
      findings,
      `These files create tables from the application:\n\n${findings.join("\n")}\n\n` +
        `It cannot work: the API connects with a role without the CREATE privilege, ` +
        `which is what makes RLS isolation effective. And the failure is ` +
        `silent — an error is logged and the kon starts anyway.\n\n` +
        `Move the SQL to packages/kons/<kon>/migrations/NNNN_*.sql. There it is applied ` +
        `with the admin role, recorded in kitsuden_migrations ` +
        `and fails loudly if something goes wrong.`
    ).toEqual([]);
  });
});
