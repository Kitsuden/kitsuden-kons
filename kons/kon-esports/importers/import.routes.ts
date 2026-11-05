/**
 * Import routes
 * ============================================================================
 *
 * Two steps ALWAYS: preview and confirmation.
 *
 * The same reason as in the check-in resolver — importing 250 registrants onto
 * a tournament that already has people loaded is not an operation to press
 * blindly. The preview writes nothing and answers "47 enter, 3 are updated,
 * 2 are no longer there, the pool is $212.50". Only with `confirm: true` does it write.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE START.GG TOKEN IS NOT STORED
 *
 * It travels in the request body and dies with it. Storing it would require
 * encrypting it, rotating it and answering for it, and a start.gg token grants access to
 * ALL the tournaments of that account, not just the one being imported. Whoever wants to
 * automate it can put it in `STARTGG_TOKEN` and accept that decision.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { AnyOperation } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { EsportsDb } from "../esports.db.js";
import { prizePoolSnapshots, tournaments } from "../esports.schema.js";
import { Obj, TournamentParam, query, text } from "../schemas.js";
import { ORGANIZATION_ONLY, registry } from "../operations.js";

import { importFromBattlefyExport } from "./battlefy.js";
import { applyImport, planImport } from "./import.persistence.js";
import { ImportError, type ImportSource, type ImportedTournament } from "./import.types.js";
import { importFromMatcherino } from "./matcherino.js";
import { importFromStartgg } from "./startgg.js";

const SOURCES: ImportSource[] = ["startgg", "matcherino", "battlefy"];

interface ImportBody {
  source?: string;
  reference?: string;
  token?: string;
  confirm?: boolean;
  onMissing?: "ignore" | "eliminate";
  includeSets?: boolean;
  /** Battlefy only: the contents of the file exported from the panel. */
  fileContent?: string;
  title?: string;
  gameName?: string;
  isTeamEvent?: boolean;
}

/**
 * The import body. `source` is text and not an enum on purpose: if it is
 * missing or not in the list, the route gives its usual 400 saying which ones
 * are valid.
 */
const ImportBodyValue = z.object({
  source: z.string().max(40).optional().describe("startgg | matcherino | battlefy"),
  reference: z
    .string()
    .max(2000)
    .optional()
    .describe("URL or id of the source event (not Battlefy)"),
  token: z
    .string()
    .max(4000)
    .optional()
    .describe("start.gg personal token; used for this request only, never stored"),
  confirm: z.boolean().optional().describe("Without it, only the preview: nothing is written"),
  onMissing: z.enum(["ignore", "eliminate"]).optional(),
  includeSets: z.boolean().optional().describe("start.gg: also bring the played sets"),
  fileContent: z.string().max(5_000_000).optional().describe("Battlefy: the exported CSV or JSON"),
  title: z.string().max(200).optional(),
  gameName: z.string().max(120).optional(),
  isTeamEvent: z.boolean().optional(),
});

export function importOperations(ctx: KonContext): AnyOperation[] {
  const app = registry("/import");
  const { db: rawDb } = ctx;
  const db = rawDb.instance as EsportsDb;

  /**
   * What can be imported and what each one needs.
   *
   * The interface asks for it in order to draw the form: without this, the token field
   * would also appear for Matcherino (which uses none) and that list would have to be
   * maintained by hand in the client.
   */
  app.get(
    "/sources",
    {
      id: "import-sources",
      summary: "Import sources",
      description:
        "What can be imported (start.gg, Matcherino, Battlefy), what each one needs (token, URL or file) and what it brings.",
      access: "public",
      output: { schema: z.object({ data: z.array(Obj) }) },
    },
    (c) =>
      c.json({
        data: [
          {
            id: "startgg",
            label: "start.gg",
            requiresToken: true,
            tokenHint: "Personal token from start.gg/admin/profile/developer (expires after a year)",
            referenceHint: "EVENT URL: https://start.gg/tournament/my-tournament/event/singles",
            brings: ["participants", "seeds", "sets"],
            official: true,
          },
          {
            id: "matcherino",
            label: "Matcherino",
            requiresToken: false,
            referenceHint: "Matcherino tournament URL or numeric id",
            brings: ["participants", "prizePool"],
            // It is declared: Matcherino does not publish an API, and whoever imports must know
            // that this may stop working without notice.
            official: false,
            note: "Matcherino does not publish an API. Its internal endpoint is read, which may change without notice.",
          },
          {
            id: "battlefy",
            label: "Battlefy",
            requiresToken: false,
            // The mode is FILE and it is stated in the contract itself so that the
            // interface draws a file picker and not a URL box.
            mode: "file",
            referenceHint:
              "Export the participants from your Battlefy panel and upload the CSV or the JSON",
            brings: ["participants", "seeds"],
            official: false,
            note:
              'Battlefy\'s API answers "Direct API access is not permitted". ' +
              "It is imported from the export the organizer downloads themselves, which " +
              "also works with private tournaments.",
          },
        ],
      })
  );

  /**
   * Preview + apply.
   *
   * A single route with `confirm` instead of two: it guarantees that what is applied
   * was computed with the SAME code that was shown. With separate routes, a
   * change in one and not the other makes the TO confirm something different from
   * what they saw, and no test of the preview route detects that.
   */
  app.post(
    "/tournament/:id/import",
    {
      id: "import-tournament",
      summary: "Import participants (and sets) from another platform",
      description:
        "Two steps with the same call: without `confirm` it returns a preview (who is created, updated or missing, prize pool, warnings) and writes nothing; with `confirm: true` it applies it. 502 when the other platform fails (retry), 400 when the reference is wrong. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      // With `confirm` it writes dozens of registrations at once.
      sensitive: true,
      input: { params: TournamentParam, body: ImportBodyValue.optional() },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_GATEWAY"],
    },
    async (c) => {
      const tournamentId = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) as ImportBody;

      const source = body.source as ImportSource | undefined;
      if (!source || !SOURCES.includes(source)) {
        return c.json({ error: `\`source\` must be one of: ${SOURCES.join(", ")}` }, 400);
      }
      // Battlefy goes by file; the rest by reference. What applies in each case is
      // checked so the message says what is really missing.
      if (source === "battlefy") {
        if (!body.fileContent?.trim()) {
          return c.json(
            { error: "`fileContent` is missing: upload the participant export from Battlefy" },
            400
          );
        }
      } else if (!body.reference?.trim()) {
        return c.json({ error: "`reference` is missing: the URL or id of the source event" }, 400);
      }

      // Outside things first and THEN the database. The request transaction is
      // lazy: until the first query it holds no connection, and start.gg
      // can be a hundred pages in series (1 + 60 + 60, at 80/min). With
      // the tournament check first, all of that ran with the transaction
      // open and Postgres cuts it at 60 s (`idle_in_transaction_session_timeout`).
      // Price: a tournament id that does not exist costs one download (staff route).
      let imported: ImportedTournament;
      try {
        if (source === "startgg") {
          imported = await importFromStartgg(
            body.reference!,
            body.token || process.env.STARTGG_TOKEN || "",
            { includeSets: body.includeSets }
          );
        } else if (source === "battlefy") {
          imported = importFromBattlefyExport(body.fileContent!, {
            title: body.title,
            gameName: body.gameName,
            isTeamEvent: body.isTeamEvent,
            url: body.reference,
          });
        } else {
          imported = await importFromMatcherino(body.reference!);
        }
      } catch (err) {
        if (err instanceof ImportError) {
          // 502 when the failure is on the other end and 400 when it is with what we
          // were asked: it is the difference between "retry" and "fix the URL".
          return c.json(
            { error: err.message, retryable: err.retryable },
            err.retryable ? 502 : 400
          );
        }
        throw err;
      }

      const [tournament] = await db
        .select({ id: tournaments.id })
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);
      if (!tournament) return c.json({ error: "Tournament not found" }, 404);

      const plan = await planImport(db, tournamentId, imported);

      const preview = {
        source: imported.source,
        title: imported.title,
        game: imported.gameName,
        url: imported.url,
        isTeamEvent: imported.isTeamEvent,
        counts: {
          create: plan.toCreate.length,
          update: plan.toUpdate.length,
          missing: plan.missing.length,
          playedSets: plan.playedSets,
        },
        // A sample, not the whole list: in a 300-player tournament the TO wants to
        // recognize a couple of names to know it is the right event, not to
        // read 300 lines before pressing.
        sample: plan.toCreate.slice(0, 8).map((p) => p.name),
        missing: plan.missing.map((m) => m.name),
        prizePool: plan.prizePool,
        warnings: plan.warnings,
      };

      if (!body.confirm) {
        return c.json({ preview, applied: false });
      }

      const outcome = await applyImport(db, tournamentId, imported, {
        onMissing: body.onMissing ?? "ignore",
      });

      return c.json({ preview, applied: true, outcome });
    }
  );

  /**
   * Resyncs ONLY the prize pool.
   *
   * It exists separately because it is the only thing that keeps changing: the
   * Matcherino pot rises while the tournament is played, and going through the whole
   * import again to refresh one number would move registrations that are
   * already decided.
   *
   * On request and not in a loop: it is a third party's internal endpoint.
   */
  app.post(
    "/tournament/:id/prize-pool/sync",
    {
      id: "sync-prize-pool",
      summary: "Refresh the prize pool from Matcherino",
      description:
        "Reads the current prize pool of the linked Matcherino tournament, stores a snapshot and updates the tournament. 409 if the tournament is not linked to Matcherino. Tournament staff only.",
      access: "session",
      permission: ORGANIZATION_ONLY,
      input: { params: TournamentParam },
      output: { schema: Obj },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT", "KITSUDEN_E_BAD_GATEWAY"],
    },
    async (c) => {
      const tournamentId = c.req.param("id");

      const [tournament] = await db
        .select({
          id: tournaments.id,
          externalSource: tournaments.externalSource,
          externalId: tournaments.externalId,
        })
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);

      if (!tournament) return c.json({ error: "Tournament not found" }, 404);
      if (tournament.externalSource !== "matcherino" || !tournament.externalId) {
        return c.json(
          { error: "This tournament is not linked to Matcherino. Import it first." },
          409
        );
      }

      let imported: ImportedTournament;
      try {
        imported = await importFromMatcherino(tournament.externalId);
      } catch (err) {
        if (err instanceof ImportError) {
          return c.json(
            { error: err.message, retryable: err.retryable },
            err.retryable ? 502 : 400
          );
        }
        throw err;
      }

      if (!imported.prizePool) {
        return c.json(
          { error: "Matcherino did not return the pool", warnings: imported.warnings },
          502
        );
      }

      const pool = imported.prizePool;

      const [updated] = await db.transaction(async (tx) => {
        // The snapshot goes in the SAME transaction as the current figure: if it were
        // saved separately, a failure between the two would leave a curve with a jump
        // nobody could explain three weeks later.
        await tx.insert(prizePoolSnapshots).values({
          tournamentId,
          cents: pool.cents,
          currency: pool.currency,
          contributors: pool.contributors ?? null,
          source: "matcherino",
        });

        return tx
          .update(tournaments)
          .set({
            prizePoolCents: pool.cents,
            prizePoolCurrency: pool.currency,
            prizePoolSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tournaments.id, tournamentId))
          .returning();
      });

      return c.json({ data: updated, prizePool: pool });
    }
  );

  /**
   * The pool, for the web and the overlay. **No session**: it is a public figure, and
   * what makes it useful is that everyone sees it at the same time.
   *
   * It returns the current value, the recent history and the increment, already
   * computed. The delta is THE data point —"it has risen $50 in the last hour" is what
   * moves a pot— and computing it in each client would repeat in three places
   * (web, overlay, bot) a subtraction that is done once here.
   */
  app.get(
    "/public/tournament/:id/prize-pool",
    {
      id: "get-prize-pool",
      summary: "Prize pool of a tournament",
      description:
        "Current prize pool, currency, contributors, the change since the last snapshot (can be negative) and the recent history (oldest first). `data: null` if the tournament has none.",
      access: "public",
      input: {
        params: TournamentParam,
        query: query({ history: text("Snapshots to return, max 200 (default 24)") }),
      },
      output: {
        schema: z.object({ data: Obj.nullable(), history: z.array(Obj).optional() }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const tournamentId = c.req.param("id");

      const [tournament] = await db
        .select({
          cents: tournaments.prizePoolCents,
          currency: tournaments.prizePoolCurrency,
          syncedAt: tournaments.prizePoolSyncedAt,
          externalSource: tournaments.externalSource,
        })
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);

      if (!tournament) return c.json({ error: "Tournament not found" }, 404);
      if (tournament.cents === null) return c.json({ data: null });

      const limit = Math.min(Number(c.req.query("history")) || 24, 200);
      const history = await db
        .select({
          cents: prizePoolSnapshots.cents,
          contributors: prizePoolSnapshots.contributors,
          capturedAt: prizePoolSnapshots.capturedAt,
        })
        .from(prizePoolSnapshots)
        .where(eq(prizePoolSnapshots.tournamentId, tournamentId))
        .orderBy(desc(prizePoolSnapshots.capturedAt))
        .limit(limit);

      const previous = history[1]?.cents ?? null;

      return c.json({
        data: {
          cents: tournament.cents,
          currency: tournament.currency ?? "USD",
          syncedAt: tournament.syncedAt,
          contributors: history[0]?.contributors ?? null,
          source: tournament.externalSource,
          /**
           * It can be NEGATIVE, and it is returned as is: refunds exist.
           * Clamping it to zero would show a pot that never goes down, which is a lie,
           * and would leave the overlay animating upward a figure that fell.
           */
          deltaSinceLast: previous === null ? null : tournament.cents - previous,
        },
        // Oldest to newest: it is the order in which a curve is drawn.
        history: [...history].reverse(),
      });
    }
  );

  return app.ops;
}
