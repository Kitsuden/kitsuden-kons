/**
 * Battlefy importer
 * ============================================================================
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS READS A FILE AND NOT AN API
 *
 * Battlefy has an API, and it answers this to anyone who calls it directly:
 *
 *     {"error":"Forbidden","message":"Direct API access is not permitted"}
 *
 * It is not a bug or a rate limit: it is a policy written into the response.
 * There are libraries that sidestep it with browser headers, and that is
 * exactly the reason why it is NOT done here — evading a control the
 * owner has put there on purpose is a problem for whoever deploys Kitsuden,
 * not a feature.
 *
 * So it imports through the door Battlefy DOES leave open: the export the
 * organizer themselves downloads from their panel. It has three advantages over scraping:
 *
 *   · It does not break when they change their API.
 *   · It works with private tournaments, which are most community ones.
 *   · Whoever exports is the one entitled to that data.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ImportError, type ImportedParticipant, type ImportedTournament } from "./import.types.js";

/** Defensive cap. A CSV larger than this is not a list of registrants. */
const MAX_ROWS = 10_000;

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Splits a CSV line respecting quotes.
 *
 * Written by hand, without a library, because the case that matters is specific and
 * small: team names contain commas (`Team Liquid, EU`) and quotes
 * are escaped by doubling them. A full library would bring its own
 * surface for a file a user uploads.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (quoted) {
      if (char === '"') {
        // Doubled quote = a literal quote, not the end of the field.
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      out.push(field);
      field = "";
    } else field += char;
  }

  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Finds a column by any of its possible names.
 *
 * Battlefy does not always export the same headers: they change between games and
 * between panel versions, and custom fields come out with the name
 * the organizer gave them. Searching by synonyms and case-insensitively
 * keeps a change of wording from leaving the import blank.
 */
function columnIndex(headers: string[], candidates: string[]): number {
  const normalized = headers.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ""));
  for (const candidate of candidates) {
    const target = candidate.toLowerCase().replace(/[\s_-]+/g, "");
    const index = normalized.indexOf(target);
    if (index !== -1) return index;
  }
  return -1;
}

const ID_COLUMNS = ["userid", "id", "playerid", "teamid", "participantid", "_id"];
const NAME_COLUMNS = [
  "name",
  "team",
  "teamname",
  "ingamename",
  "username",
  "gamertag",
  "displayname",
];
const SEED_COLUMNS = ["seed", "seednumber"];
const COUNTRY_COLUMNS = ["country", "countrycode", "region"];

export interface BattlefyImportOptions {
  /** Tournament name, if the CSV does not carry it (which is the normal case). */
  title?: string;
  gameName?: string;
  isTeamEvent?: boolean;
  /** URL of the tournament on Battlefy, so one can go back. */
  url?: string;
}

/**
 * Imports from Battlefy's participant export.
 *
 * Accepts CSV and also the JSON its export returns in some panels:
 * whoever downloads a file should not have to know which of the two they
 * got.
 */
export function importFromBattlefyExport(
  content: string,
  options: BattlefyImportOptions = {}
): ImportedTournament {
  const trimmed = content.trim();
  if (!trimmed) throw new ImportError("The file is empty.");

  const warnings: string[] = [];
  const participants =
    trimmed.startsWith("[") || trimmed.startsWith("{")
      ? fromJson(trimmed, warnings)
      : fromCsv(trimmed, warnings);

  if (participants.length === 0) {
    throw new ImportError(
      "No participant was recognized. Check that it is the " +
        "PARTICIPANTS export from Battlefy and not the bracket's."
    );
  }

  return {
    source: "battlefy",
    // Without an API there is no reliable tournament id; the one from the URL is used if they gave it.
    externalId:
      options.url?.match(/([0-9a-f]{24})/i)?.[1] ?? `battlefy-import-${participants.length}`,
    url: options.url ?? null,
    title: options.title?.trim() || "Tournament imported from Battlefy",
    gameName: options.gameName ?? null,
    startsAt: null,
    isTeamEvent: options.isTeamEvent ?? false,
    participants,
    // The participant export does NOT carry the bracket. Kitsuden generates its
    // own with the imported seeding, the same as with start.gg.
    sets: [],
    prizePool: null,
    warnings,
  };
}

function fromCsv(content: string, warnings: string[]): ImportedParticipant[] {
  // `\r\n` and `\r` included: an export opened in Excel on Windows and
  // saved again changes the line endings, and splitting only on `\n`
  // would leave a `\r` stuck to each last field.
  const lines = content.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new ImportError("The CSV has no data rows, only a header.");

  const headers = parseCsvLine(lines[0]);
  const idIndex = columnIndex(headers, ID_COLUMNS);
  const nameIndex = columnIndex(headers, NAME_COLUMNS);
  const seedIndex = columnIndex(headers, SEED_COLUMNS);
  const countryIndex = columnIndex(headers, COUNTRY_COLUMNS);

  if (nameIndex === -1) {
    throw new ImportError(
      `The name column was not found. Headers read: ${headers.join(", ")}`
    );
  }
  if (idIndex === -1) {
    // Without a stable id the matching goes by name, which is exactly what the external
    // identity exists to avoid. A warning is given instead of failing: better to import
    // with a known limitation than not to import.
    warnings.push(
      "The CSV carries no identifier; the name will be used as identity. " +
        "A rename will create a duplicate on re-import."
    );
  }

  const rows = lines.slice(1, MAX_ROWS + 1);
  if (lines.length - 1 > MAX_ROWS) {
    warnings.push(
      `The file has ${lines.length - 1} rows; the first ones imported are ${MAX_ROWS}.`
    );
  }

  const out: ImportedParticipant[] = [];
  const seen = new Set<string>();

  for (const [index, line] of rows.entries()) {
    const cells = parseCsvLine(line);
    const name = cells[nameIndex]?.trim();
    if (!name) continue;

    const externalId = (idIndex !== -1 ? cells[idIndex]?.trim() : "") || `name:${name}`;
    if (seen.has(externalId)) {
      warnings.push(`Row ${index + 2}: "${name}" is repeated; the second one is ignored.`);
      continue;
    }
    seen.add(externalId);

    const seed = seedIndex !== -1 ? Number.parseInt(cells[seedIndex] ?? "", 10) : Number.NaN;
    const country = countryIndex !== -1 ? cells[countryIndex]?.trim().toUpperCase() : "";

    out.push({
      externalId,
      name,
      seed: Number.isFinite(seed) && seed > 0 ? seed : null,
      // Only the two-letter code, same rule as in start.gg: a wrong
      // flag on a broadcast is worse than no flag.
      country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    });
  }

  return out;
}

function fromJson(content: string, warnings: string[]): ImportedParticipant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ImportError("The file looks like JSON but cannot be read.");
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { teams?: unknown })?.teams)
      ? (parsed as { teams: unknown[] }).teams
      : Array.isArray((parsed as { participants?: unknown })?.participants)
        ? (parsed as { participants: unknown[] }).participants
        : null;

  if (!list) {
    throw new ImportError(
      "The JSON does not contain a recognizable list of participants (expected an " +
        "array, or an object with `teams` or `participants`)."
    );
  }

  const out: ImportedParticipant[] = [];
  const seen = new Set<string>();

  for (const raw of list.slice(0, MAX_ROWS)) {
    const entry = raw as Record<string, unknown>;
    const name = String(entry.name ?? entry.teamName ?? entry.inGameName ?? "").trim();
    if (!name) continue;

    const externalId = String(entry._id ?? entry.id ?? entry.userID ?? "") || `name:${name}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const members = Array.isArray(entry.players)
      ? (entry.players as Array<Record<string, unknown>>)
          .map((p) => ({
            externalId: String(p._id ?? p.id ?? p.inGameName ?? ""),
            name: String(p.inGameName ?? p.name ?? "").trim(),
          }))
          .filter((m) => m.externalId && m.name)
      : undefined;

    out.push({
      externalId,
      name,
      seed: null,
      country: null,
      members: members && members.length > 0 ? members : undefined,
    });
  }

  if (out.length > 0 && out.every((p) => p.externalId.startsWith("name:"))) {
    warnings.push("No participant carries an identifier; the name will be used as identity.");
  }

  return out;
}
