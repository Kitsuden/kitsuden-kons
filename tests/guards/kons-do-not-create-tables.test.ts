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

/**
 * ── AND NOT BY READING THEIR OWN MIGRATIONS EITHER ─────────────────────────
 *
 * The check above reads the TypeScript. kon-crm passed it for months while doing the same thing
 * one step removed: at startup, with a table missing, it listed `migrations/`, read every
 * `.sql` and ran it with `sql.raw` — outside the runner's ledger (so the runner applies them
 * again), as the application role, and from a path under the working directory that only
 * exists in one layout. There is no `CREATE TABLE` in that code: it is in the files it reads.
 *
 * So a kon's runtime source may not NAME its migrations: no string that is the `migrations`
 * folder, a path through it, or a `.sql` file. A sentence in a log ("run the kon's migrations")
 * is not a path and is allowed. Tests and admin sources are not runtime and are not read.
 */
const NAMES_A_MIGRATION =
  /(["'`])(?:migrations|[^"'`\n]*(?:\/migrations\b|\bmigrations\/)[^"'`\n]*|[^"'`\n]*\.sql)\1/g;

describe("kons do not create tables at runtime", () => {
  const findings: string[] = [];
  const migrationReaders: string[] = [];

  const sources = [
    ...listFiles(join(ROOT, "kons"), ".ts"),
    ...listFiles(join(ROOT, ".kitsuden", "packages", "core"), ".ts"),
  ].filter((f) => !f.includes(".test.") && !f.endsWith(".d.ts"));

  const relative = (file: string) =>
    file
      .slice(ROOT.length + 1)
      .split(sep)
      .join("/");

  for (const file of sources) {
    const code = withoutComments(readFileSync(file, "utf-8"));

    const runtime = !/\/(tests|admin-src|admin|node_modules|dist)\//.test(relative(file));
    if (runtime && relative(file).startsWith("kons/")) {
      for (const m of code.matchAll(NAMES_A_MIGRATION)) {
        const line = code.slice(0, m.index).split("\n").length;
        migrationReaders.push(`${relative(file)}:${line}  ${m[0]}`);
      }
    }

    for (const m of code.matchAll(/CREATE\s+(?:(TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE/gi)) {
      // Temporary ones live in the session: they do not need CREATE on the schema
      // and disappear on their own. They are not the problem.
      if (m[1]) continue;

      const line = code.slice(0, m.index).split("\n").length;
      findings.push(`${relative(file)}:${line}`);
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

  it("no kon source reads its migration files at runtime", () => {
    expect(
      migrationReaders,
      `These kon sources name the migrations folder or a .sql file:\n\n${migrationReaders.join("\n")}\n\n` +
        `A kon never applies its own migrations: the host's runner does (\`kitsuden kon add\`, ` +
        `the migration step of a deploy), with the admin role and its ledger. At startup a kon ` +
        `only CHECKS (\`ctx.db.tableExists\`) and warns, as kon-conta and kon-crm do.`
    ).toEqual([]);
  });

  it("the migration check sees what kon-crm used to do", () => {
    const before = [
      `const migrationsDir = join(process.cwd(), "packages", "kons", "kon-crm", "migrations");`,
      `const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();`,
      "const dir = `${root}/migrations`;",
      `readFileSync(resolve(here, "./migrations/0000_initial.sql"), "utf8");`,
    ];
    for (const line of before) {
      expect([...line.matchAll(NAMES_A_MIGRATION)].length, line).toBeGreaterThan(0);
    }
    const allowed = [
      `ctx.logger.warn("[CRM] Tables missing: run the kon's migrations", { missing });`,
      `description: "Applies pending SQL in order.",`,
    ];
    for (const line of allowed) {
      expect([...line.matchAll(NAMES_A_MIGRATION)], line).toEqual([]);
    }
  });
});
