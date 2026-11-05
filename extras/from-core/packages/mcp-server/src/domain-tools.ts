/**
 * Domain MCP tools — what an agent needs to build in the niche
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * The MCP server exposed 27 tools and all of them were generic:
 * `kitsuden_create_record`, `kitsuden_query_table`, `kitsuden_search_code`…
 * None to create a tournament, report a set or sync a tier list.
 *
 * So an agent that wanted to report a set ended up writing the row by
 * hand in `esports_matches` —with the generic tool— and skipping precisely
 * what Kitsuden sells: that a Bo5 is not closed at 1-0, that Swiss breaks ties
 * correctly, that a result is not corrected once the next round is published.
 *
 * ── WHAT THERE IS NOW ──────────────────────────────────────────────────────
 *
 * Tools named after the domain that call the kons' ROUTES, not
 * the database. The rules, the authorization and the errors that explain what
 * is missing are the API's: a tool cannot skip them because it
 * has no other door.
 *
 * Each description says what an agent tends to confuse —the participant id
 * versus the player id, `bestOf` versus `firstTo`— because it is what the agent
 * reads right before calling.
 *
 * ── WHY THEY RECEIVE THE API INJECTED ──────────────────────────────────────
 *
 * `runDomainTool` receives the function that calls the API. On the server it is the
 * HTTP request with the agent's token; in tests, the router mounted in
 * memory. This way the path that is tested is exactly the one an agent uses.
 */

/** Calls the API. `path` is relative to `/api`. Throws if the response is not 2xx. */
export type ApiCall = (path: string, method?: string, body?: unknown) => Promise<unknown>;

// An alias and not an interface, for the same reason as `ToolResult`: the
// Anthropic SDK types `input_schema` with an index signature.
type InputSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

// An alias and not an interface: the MCP SDK types the result with an index signature,
// and an interface does not have one implicitly.
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Utilities ────────────────────────────────────────────────────────────────

const DEFAULT_ROWS = [
  { id: "s", label: "S", color: "#ff7f7f" },
  { id: "a", label: "A", color: "#ffbf7f" },
  { id: "b", label: "B", color: "#ffdf7f" },
  { id: "c", label: "C", color: "#bfff7f" },
  { id: "d", label: "D", color: "#7fbfff" },
];

function slugOf(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Removes `undefined` keys: the API rejects what it does not know, but there is no need to send gaps. */
function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function similar(key: string, valid: string[]): string | null {
  const n = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
  let best: string | null = null;
  let smaller = Infinity;
  for (const v of valid) {
    if (n(v) === n(key)) return v;
    const d = distance(n(key), n(v));
    if (d < smaller) {
      smaller = d;
      best = v;
    }
  }
  return smaller <= Math.max(2, Math.floor(key.length / 3)) ? best : null;
}

/**
 * Arguments are checked the same way the API checks bodies: an
 * argument that does not exist is an error with a suggestion, not a value that
 * gets lost. Many MCP clients do not validate against `inputSchema` before calling.
 */
function validateArguments(
  def: ToolDefinition,
  args: Record<string, unknown>
): string | null {
  const valid = Object.keys(def.inputSchema.properties);
  const problems: string[] = [];

  for (const key of Object.keys(args)) {
    if (valid.includes(key)) continue;
    const suggestion = similar(key, valid);
    problems.push(
      `«${key}» does not exist${suggestion ? ` (did you mean «${suggestion}»?)` : ""}`
    );
  }
  for (const key of def.inputSchema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      problems.push(`missing «${key}»`);
    }
  }

  return problems.length
    ? `Invalid arguments for ${def.name}: ${problems.join("; ")}. Valid: ${valid.join(", ")}.`
    : null;
}

// ── API shapes that are read here ────────────────────────────────────────────

interface TierListApi {
  slug: string;
  title: string;
  catalogDatasetId?: string | null;
  tiers: { id: string; label: string }[];
  items: { id: string; label: string; imageUrl?: string | null }[];
  placement: Record<string, string>;
}

interface TournamentApi {
  id: string;
  title: string;
  status: string;
  bracketFormat: string;
  format?: string;
  swissRounds?: number | null;
  checkInOpensAt?: string | null;
  checkInClosesAt?: string | null;
  participants?: {
    id: string;
    status?: string;
    checkedInAt?: string | null;
    player?: { alias?: string | null } | null;
    team?: { name?: string | null } | null;
  }[];
}

interface SetRowApi {
  id: string;
  round: number;
  participant1Id: string | null;
  participant2Id: string | null;
  winnerId: string | null;
  participant1Score?: number;
  participant2Score?: number;
  status?: string;
}

/**
 * Tier list in the shape that is useful to an agent: rows with their elements and the ids for moving.
 *
 * Each item carries its `imageUrl` if it has one. Without it, an agent that reads the
 * list and resyncs it with what it read would send the items without a portrait.
 */
function tierListSummary(data: TierListApi) {
  const ids = new Set(data.tiers.map((t) => t.id));
  const card = (i: TierListApi["items"][number]) => ({
    id: i.id,
    label: i.label,
    ...(i.imageUrl ? { imageUrl: i.imageUrl } : {}),
  });
  return {
    slug: data.slug,
    title: data.title,
    catalogDatasetId: data.catalogDatasetId ?? null,
    tiers: data.tiers.map((t) => ({
      id: t.id,
      label: t.label,
      items: data.items.filter((i) => data.placement[i.id] === t.id).map(card),
    })),
    unranked: data.items.filter((i) => !ids.has(data.placement[i.id])).map(card),
  };
}

function namesOf(tournament: TournamentApi): Record<string, string> {
  const names: Record<string, string> = {};
  for (const p of tournament.participants ?? []) {
    names[p.id] = p.player?.alias ?? p.team?.name ?? p.id.slice(0, 8);
  }
  return names;
}

/**
 * A tournament's sets, with names and ids.
 *
 * By default, only those that can be reported now. With `includeResolved`,
 * also those that already have a winner: without them there was no way to correct a
 * result, because a set's id only appeared while it was open.
 */
async function setsOf(tournamentId: string, api: ApiCall, includeResolved = false) {
  const id = encodeURIComponent(tournamentId);
  const tournament = (await api(`/esports/tournaments/${id}`)) as TournamentApi;
  const rows = (await api(`/esports/matches/tournament/${id}`)) as SetRowApi[];
  const names = namesOf(tournament);
  const name = (pid: string) => names[pid] ?? pid.slice(0, 8);

  // A bye is not played: one side is missing.
  const jugables = rows
    .filter((f) => f.participant1Id && f.participant2Id)
    .sort((a, b) => a.round - b.round);
  const sides = (f: SetRowApi) =>
    [f.participant1Id!, f.participant2Id!].map((pid) => ({
      participantId: pid,
      name: name(pid),
    }));

  const open = jugables
    .filter((f) => !f.winnerId && f.status !== "Bye" && f.status !== "Completed")
    .map((f) => ({ matchId: f.id, round: f.round, sides: sides(f) }));

  const resolvedItems = includeResolved
    ? jugables
        .filter((f) => f.winnerId)
        .map((f) => ({
          matchId: f.id,
          round: f.round,
          sides: sides(f),
          winner: { participantId: f.winnerId!, name: name(f.winnerId!) },
          // In the order of `sides`, same as participant1Score / participant2Score.
          score: [f.participant1Score ?? 0, f.participant2Score ?? 0],
        }))
    : undefined;

  return {
    tournamentId: tournament.id,
    bracketFormat: tournament.bracketFormat,
    openSets: open,
    ...(resolvedItems ? { completedSets: resolvedItems } : {}),
    note: open.length
      ? "Report each set with tournament_report_set: its matchId and the winner's participantId."
      : tournament.bracketFormat === "swiss"
        ? "No open sets remain: pair the next round with tournament_next_round."
        : "There are no open sets.",
  };
}

// ── Definitions ──────────────────────────────────────────────────────────────

const string = (description: string) => ({ type: "string", description });
const integer = (description: string) => ({ type: "integer", description });

export const DOMAIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "kitsuden_guide",
    description:
      "Guide for agents of this Kitsuden: rules that are often broken, recipes (character tier list, Swiss tournament with check-in) and all the kon routes. Read it before building.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kitsuden_describe_api",
    description:
      "Compact list of the contract's routes: method, path, whether it requires a credential and the body fields (* = required). Filter by kon with `kon` (esports, tierlist, broadcast…).",
    inputSchema: {
      type: "object",
      properties: { kon: string("Kon to list, e.g. `esports`. Without it, all.") },
      additionalProperties: false,
    },
  },
  {
    name: "catalog_create",
    description:
      "Creates a catalog (a dataset): characters, items, cards… It is where a tier list gets its items from. With `withImage` (yes by default) it adds an `image` field of type URL, which is the one the tier list uses as the portrait. Returns `datasetId`.",
    inputSchema: {
      type: "object",
      properties: {
        name: string("Display name, e.g. `Characters`."),
        slug: string("Optional. Derived from the name."),
        description: string("Opcional."),
        withImage: {
          type: "boolean",
          description: "Add the `image` field (URL). Defaults to true.",
        },
        fields: {
          type: "array",
          description:
            "Extra fields: `{ name, type, label?, required? }`. Types: text, number, url, select, boolean…",
          items: { type: "object" },
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "catalog_add_entries",
    description:
      'Adds entries to a catalog in bulk. Each entry carries `title` (the name shown on the item) and the rest of the catalog\'s fields, e.g. `{ title: "Aria", image: "https://…" }`.',
    inputSchema: {
      type: "object",
      properties: {
        datasetId: string("Id of the catalog (from catalog_create)."),
        entries: {
          type: "array",
          items: { type: "object" },
          description: "Entries with `title` and their fields.",
        },
      },
      required: ["datasetId", "entries"],
      additionalProperties: false,
    },
  },
  {
    name: "tierlist_create",
    description:
      "Creates a tier list. With `catalogDatasetId` it is linked to that catalog and fills itself; with `catalog` it receives the items directly (`[{ id, label, imageUrl? }]`). Without `tiers` it uses S/A/B/C/D. Returns the rows with the ids of each item.",
    inputSchema: {
      type: "object",
      properties: {
        title: string("Display title."),
        slug: string("Optional. Lowercase letters, numbers and hyphens; derived from the title."),
        tiers: {
          type: "array",
          items: { type: "object" },
          description: "Rows `{ id, label, color? }` (color #rrggbb). Optional.",
        },
        catalogDatasetId: string("Catalog the items come from. Optional."),
        catalog: {
          type: "array",
          items: { type: "object" },
          description: "Direct items, if there is no catalog.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "tierlist_sync",
    description:
      "Pulls in what is new from the catalog: new items enter unranked and what is already placed does NOT move. `catalog` is the COMPLETE catalog, not just the new items. If items that were added by hand are missing, the API asks for `confirm: true` before removing them.",
    inputSchema: {
      type: "object",
      properties: {
        slug: string("Slug de la tier list."),
        datasetId: string("Another catalog. Without it, the one it already has."),
        catalog: { type: "array", items: { type: "object" }, description: "Direct items." },
        confirm: { type: "boolean", description: "Accept losing items added by hand." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "tierlist_place",
    description:
      "Places an item in a row. `tierId` is the id of the ROW (s, a…), not its label; `null` returns the item to the unranked pool. The ids come from tierlist_get.",
    inputSchema: {
      type: "object",
      properties: {
        slug: string("Slug de la tier list."),
        itemId: string("Id of the item."),
        tierId: { type: ["string", "null"], description: "Id of the row, or null to take it out." },
      },
      required: ["slug", "itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "tierlist_get",
    description:
      "The tier list grouped by rows, with the unranked elements and the ids for tierlist_place.",
    inputSchema: {
      type: "object",
      properties: { slug: string("Slug de la tier list.") },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "tierlist_list",
    description:
      "The tier lists that exist, with their `slug` and title. When you are given the name of a list that already exists, look up its slug here: the rest of the tier list tools ask for it.",
    inputSchema: {
      type: "object",
      properties: { search: string("Optional: part of the title.") },
      additionalProperties: false,
    },
  },
  {
    name: "tournament_list",
    description:
      "Searches tournaments by title and returns their `tournamentId` and status. It is the first step when you are given the name of a tournament that already exists: the other tools ask for the id, not the title.",
    inputSchema: {
      type: "object",
      properties: {
        search: string("Part of the title. Without it, all."),
        status: {
          type: "string",
          enum: ["Draft", "Open", "InProgress", "Completed"],
          description: "Opcional.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tournament_get",
    description:
      "A tournament with its format, the check-in window and its participants: each one's `participantId` and name, and whether they have already checked in. It serves to go from a name to its participantId before marking check-in or reporting.",
    inputSchema: {
      type: "object",
      properties: { tournamentId: string("Id of the tournament.") },
      required: ["tournamentId"],
      additionalProperties: false,
    },
  },
  {
    name: "tournament_create",
    description:
      "Creates a tournament. `bracketFormat`: single_elimination, double_elimination, round_robin or swiss. It is born `Open` so it can take registrations (the API would create it in Draft). Returns `tournamentId`.",
    inputSchema: {
      type: "object",
      properties: {
        title: string("Title."),
        bracketFormat: {
          type: "string",
          enum: ["single_elimination", "double_elimination", "round_robin", "swiss"],
          description: "Bracket format. Defaults to single_elimination.",
        },
        status: { type: "string", enum: ["Draft", "Open"], description: "Defaults to Open." },
        swissRounds: integer("Swiss only. Without it, they are recommended based on the players."),
        maxParticipants: integer("Defaults to 64."),
        format: { type: "string", enum: ["1v1", "Team"], description: "Defaults to 1v1." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "tournament_add_players",
    description:
      "Creates players by alias and registers them. Returns for each one `playerId` and `participantId`: for check-in and for reporting, the participantId is used, NEVER the playerId. The tournament must be Open.",
    inputSchema: {
      type: "object",
      properties: {
        tournamentId: string("Id of the tournament."),
        aliases: {
          type: "array",
          items: { type: "string" },
          description: "Names of the players.",
        },
      },
      required: ["tournamentId", "aliases"],
      additionalProperties: false,
    },
  },
  {
    name: "tournament_checkin",
    description:
      "Check-in. `action`: open (opens the window for `minutes` minutes), close, status, mark / undo (with `participantId`), drop / dq (removes or disqualifies the absent). drop goes BEFORE starting and dq after; both return the plan unless `confirm: true`.",
    inputSchema: {
      type: "object",
      properties: {
        tournamentId: string("Id of the tournament."),
        action: { type: "string", enum: ["open", "close", "status", "mark", "undo", "drop", "dq"] },
        participantId: string("For mark and undo."),
        minutes: integer("For open. Defaults to 30."),
        confirm: {
          type: "boolean",
          description: "For drop and dq: execute instead of viewing the plan.",
        },
      },
      required: ["tournamentId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "tournament_start",
    description:
      "Generates the bracket with the registered participants. In Swiss it pairs ONLY round 1: the following ones are paired with tournament_next_round when each one ends. Returns the open sets.",
    inputSchema: {
      type: "object",
      properties: {
        tournamentId: string("Id of the tournament."),
        format: {
          type: "string",
          enum: ["single_elimination", "double_elimination", "round_robin", "swiss"],
          description: "Change the format when generating. Defaults to the tournament's.",
        },
      },
      required: ["tournamentId"],
      additionalProperties: false,
    },
  },
  {
    name: "tournament_sets",
    description:
      "Sets that can be reported now, with the names and exact ids for tournament_report_set (matchId and participantId of each side). No byes. With `includeCompleted: true` it adds `completedSets`, those already resolved with their winner and score: this is what is needed to correct a result.",
    inputSchema: {
      type: "object",
      properties: {
        tournamentId: string("Id of the tournament."),
        includeCompleted: {
          type: "boolean",
          description: "Also include already-resolved sets. Defaults to false.",
        },
      },
      required: ["tournamentId"],
      additionalProperties: false,
    },
  },
  {
    name: "tournament_report_set",
    description:
      "Reports a set's winner. `winnerId` is the winner's participantId (from tournament_sets), not the playerId. The score goes by sides: `participant1Score` is that of the FIRST side of `sides` and `participant2Score` that of the second. To correct an already-resolved set, report it again with its matchId (it appears with includeCompleted); if that is no longer possible, the API says why. In elimination the bracket advances; in Swiss and round robin it returns the table and, when the round closes, what to do next.",
    inputSchema: {
      type: "object",
      properties: {
        tournamentId: string("Id of the tournament."),
        matchId: string("Id of the set (from tournament_sets)."),
        winnerId: string("participantId of the winner."),
        participant1Score: integer("Optional. Games of the first side of `sides`."),
        participant2Score: integer("Optional. Games of the second side of `sides`."),
      },
      required: ["tournamentId", "matchId", "winnerId"],
      additionalProperties: false,
    },
  },
  {
    name: "tournament_next_round",
    description:
      "Pairs the next round of a Swiss. Fails (409) if unreported sets remain in the current round. Returns the new sets.",
    inputSchema: {
      type: "object",
      properties: { tournamentId: string("Id of the tournament.") },
      required: ["tournamentId"],
      additionalProperties: false,
    },
  },
  {
    name: "tournament_standings",
    description:
      "Standings according to the format: Swiss with record and OMW (its tiebreaker), round robin by points, elimination with who is still alive. With names.",
    inputSchema: {
      type: "object",
      properties: { tournamentId: string("Id of the tournament.") },
      required: ["tournamentId"],
      additionalProperties: false,
    },
  },
  {
    name: "broadcast_sections",
    description:
      "Which parts of Broadcast are switched on. games, draft and live come switched off; if a route returns 409 with `section`, here you can see which one and how to switch it on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "broadcast_create_match",
    description:
      "Creates a matchup for the overlay. Use `bestOf` (1, 3, 5, 7, 9): the server computes how many games are needed to win. The sides are `sideA` and `sideB`, e.g. `{ name, sponsor?, color? }`.",
    inputSchema: {
      type: "object",
      properties: {
        eventTitle: string("Event title."),
        round: string("Round or phase, e.g. `Winners Final`."),
        bestOf: { type: "integer", enum: [1, 3, 5, 7, 9] },
        profileId: string("Game profile (`1v1`, `2xko`, `lol`…). Optional."),
        sideA: { type: "object", description: "Side A: `{ name, sponsor?, color? }`." },
        sideB: { type: "object", description: "Side B." },
      },
      additionalProperties: false,
    },
  },
];

// ── Execution ────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;
type Handler = (args: Args, api: ApiCall) => Promise<unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const enc = (v: unknown) => encodeURIComponent(String(v));

const MANEJADORES: Record<string, Handler> = {
  async kitsuden_guide(_args, api) {
    return api("/llms.txt");
  },

  async kitsuden_describe_api(args, api) {
    const spec = (await api("/docs/openapi.json")) as {
      paths?: Record<
        string,
        Record<
          string,
          {
            summary?: string;
            tags?: string[];
            security?: Record<string, unknown>[];
            requestBody?: {
              content?: Record<
                string,
                { schema?: { properties?: Record<string, unknown>; required?: string[] } }
              >;
            };
          }
        >
      >;
    };
    const kon = str(args.kon)?.replace(/^kon-/, "");
    const lines: string[] = [];

    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const op = item[method];
        if (!op) continue;
        if (kon && !(op.tags ?? []).some((t) => t.replace(/^kon-/, "") === kon)) continue;

        const schema = Object.values(op.requestBody?.content ?? {})[0]?.schema;
        const fields = schema?.properties
          ? Object.keys(schema.properties)
              .map((k) => ((schema.required ?? []).includes(k) ? `${k}*` : k))
              .join(", ")
          : "";
        const asksCredential =
          (op.security ?? []).some((s) => Object.keys(s).length > 0) &&
          !(op.security ?? []).some((s) => Object.keys(s).length === 0);
        const summary =
          op.summary && !op.summary.startsWith(method.toUpperCase()) ? ` — ${op.summary}` : "";

        lines.push(
          `${method.toUpperCase()} /api${path}${summary}${asksCredential ? " [credential]" : ""}${fields ? ` · body: ${fields}` : ""}`
        );
      }
    }
    return lines.length ? lines.join("\n") : `No routes${kon ? ` for «${kon}»` : ""}.`;
  },

  async catalog_create(args, api) {
    const name = String(args.name);
    const extra = (Array.isArray(args.fields) ? args.fields : []) as {
      name: string;
      type?: string;
      label?: string;
      required?: boolean;
    }[];
    const schema = [
      // `url` type and not `image`: an `image` field stores the id of an uploaded
      // media item, and here external URLs are pasted. The tier list accepts both.
      ...(args.withImage === false ? [] : [{ name: "image", type: "url", label: "Image" }]),
      ...extra.map((f) => ({
        name: f.name,
        type: f.type ?? "text",
        label: f.label ?? f.name,
        required: Boolean(f.required),
      })),
    ];
    const row = (await api(
      "/data-sets",
      "POST",
      compact({
        name: name,
        slug: str(args.slug) ?? slugOf(name),
        description: str(args.description),
        schema,
      })
    )) as { id: string; slug: string };
    return {
      datasetId: row.id,
      slug: row.slug,
      fields: schema.map((f) => f.name),
      next: "catalog_add_entries",
    };
  },

  async catalog_add_entries(args, api) {
    const inputs = (args.entries as Args[]).map(({ title, ...rest }) => ({
      title,
      data: rest,
    }));
    const rows = (await api(`/data-sets/${enc(args.datasetId)}/entries`, "POST", inputs)) as {
      id: string;
      title: string;
    }[];
    return { added: rows.length, entries: rows.map((f) => ({ id: f.id, title: f.title })) };
  },

  async tierlist_create(args, api) {
    const title = String(args.title);
    const slug = str(args.slug) ?? slugOf(title);
    await api(
      "/tierlist/templates",
      "PUT",
      compact({
        slug,
        title: title,
        tiers: (args.tiers as unknown[] | undefined) ?? DEFAULT_ROWS,
        catalogDatasetId: str(args.catalogDatasetId),
      })
    );

    if (Array.isArray(args.catalog)) {
      await api(`/tierlist/templates/${enc(slug)}/sync`, "POST", { catalog: args.catalog });
    } else if (str(args.catalogDatasetId)) {
      await api(`/tierlist/templates/${enc(slug)}/sync`, "POST", {
        datasetId: args.catalogDatasetId,
      });
    }

    const actual = (await api(`/tierlist/templates/${enc(slug)}`)) as { data: TierListApi };
    return tierListSummary(actual.data);
  },

  async tierlist_sync(args, api) {
    const r = await api(
      `/tierlist/templates/${enc(args.slug)}/sync`,
      "POST",
      compact({ datasetId: str(args.datasetId), catalog: args.catalog, confirm: args.confirm })
    );
    const actual = (await api(`/tierlist/templates/${enc(args.slug)}`)) as { data: TierListApi };
    return { sync: r, ...tierListSummary(actual.data) };
  },

  async tierlist_place(args, api) {
    if (args.tierId === undefined) {
      throw new Error(
        "Missing «tierId»: the id of the row (s, a…), or null to return the item to the pool."
      );
    }
    const r = (await api(`/tierlist/templates/${enc(args.slug)}/place`, "POST", {
      itemId: args.itemId,
      tierId: args.tierId,
    })) as { data: TierListApi };
    return tierListSummary(r.data);
  },

  async tierlist_get(args, api) {
    const r = (await api(`/tierlist/templates/${enc(args.slug)}`)) as { data: TierListApi };
    return tierListSummary(r.data);
  },

  async tierlist_list(args, api) {
    const r = (await api("/tierlist/templates")) as { data: { slug: string; title: string }[] };
    const search = str(args.search)?.toLowerCase();
    return {
      tierLists: r.data
        .filter((l) => !search || l.title.toLowerCase().includes(search))
        .map(({ slug, title }) => ({ slug, title })),
    };
  },

  async tournament_list(args, api) {
    const query = new URLSearchParams(
      compact({ search: str(args.search), status: str(args.status) }) as Record<string, string>
    ).toString();
    const rows = (await api(`/esports/tournaments${query ? `?${query}` : ""}`)) as {
      id: string;
      title: string;
      status: string;
      format: string;
    }[];
    return {
      tournaments: rows.map((t) => ({
        tournamentId: t.id,
        title: t.title,
        status: t.status,
        format: t.format,
      })),
    };
  },

  async tournament_get(args, api) {
    const t = (await api(`/esports/tournaments/${enc(args.tournamentId)}`)) as TournamentApi;
    const names = namesOf(t);
    return {
      tournamentId: t.id,
      title: t.title,
      status: t.status,
      bracketFormat: t.bracketFormat,
      format: t.format,
      swissRounds: t.swissRounds ?? null,
      checkInWindow: { opensAt: t.checkInOpensAt ?? null, closesAt: t.checkInClosesAt ?? null },
      participants: (t.participants ?? []).map((p) => ({
        participantId: p.id,
        name: names[p.id],
        status: p.status,
        checkedIn: Boolean(p.checkedInAt),
      })),
      note: "participantId is used for check-in and for reporting.",
    };
  },

  async tournament_create(args, api) {
    const t = (await api(
      "/esports/tournaments",
      "POST",
      compact({
        title: args.title,
        bracketFormat: args.bracketFormat,
        status: args.status ?? "Open",
        swissRounds: args.swissRounds,
        maxParticipants: args.maxParticipants,
        format: args.format,
      })
    )) as { id: string; title: string; status: string; bracketFormat: string };
    return {
      tournamentId: t.id,
      title: t.title,
      status: t.status,
      bracketFormat: t.bracketFormat,
      next: "tournament_add_players",
    };
  },

  async tournament_add_players(args, api) {
    const registered: { alias: string; playerId: string; participantId: string }[] = [];
    for (const alias of args.aliases as string[]) {
      const player = (await api("/esports/players", "POST", { alias })) as { id: string };
      const participant = (await api(
        `/esports/tournaments/${enc(args.tournamentId)}/register`,
        "POST",
        {
          playerId: player.id,
        }
      )) as { id?: string; data?: { id: string } };
      registered.push({
        alias,
        playerId: player.id,
        participantId: participant.id ?? participant.data?.id ?? "",
      });
    }
    return {
      registered: registered,
      note: "participantId is the id for check-in and for reporting. playerId is no use for that.",
    };
  },

  async tournament_checkin(args, api) {
    const id = enc(args.tournamentId);
    const status = () => api(`/esports/tournament/${id}/check-in`);
    const now = Date.now();

    switch (args.action) {
      case "open": {
        const minutes = typeof args.minutes === "number" ? args.minutes : 30;
        await api(`/esports/tournament/${id}/check-in/window`, "POST", {
          opensAt: new Date(now).toISOString(),
          closesAt: new Date(now + minutes * 60_000).toISOString(),
        });
        return status();
      }
      case "close":
        await api(`/esports/tournament/${id}/check-in/window`, "POST", {
          opensAt: new Date(now - 60_000).toISOString(),
          closesAt: new Date(now).toISOString(),
        });
        return status();
      case "mark":
      case "undo":
        if (!str(args.participantId)) throw new Error(`«${args.action}» needs «participantId».`);
        await api(
          `/esports/participant/${enc(args.participantId)}/check-in`,
          args.action === "mark" ? "POST" : "DELETE"
        );
        return status();
      case "drop":
      case "dq":
        return api(
          `/esports/tournament/${id}/check-in/resolve`,
          "POST",
          compact({ action: args.action, confirm: args.confirm === true ? true : undefined })
        );
      case "status":
      default:
        return status();
    }
  },

  async tournament_start(args, api) {
    await api(
      `/esports/matches/tournament/${enc(args.tournamentId)}/generate`,
      "POST",
      compact({ format: args.format })
    );
    return setsOf(String(args.tournamentId), api);
  },

  async tournament_sets(args, api) {
    return setsOf(String(args.tournamentId), api, args.includeCompleted === true);
  },

  async tournament_report_set(args, api) {
    return api(
      `/esports/matches/tournament/${enc(args.tournamentId)}/report`,
      "POST",
      compact({
        matchId: args.matchId,
        winnerId: args.winnerId,
        participant1Score: args.participant1Score,
        participant2Score: args.participant2Score,
      })
    );
  },

  async tournament_next_round(args, api) {
    const r = await api(`/esports/tournament/${enc(args.tournamentId)}/swiss/next-round`, "POST");
    return { round: r, ...(await setsOf(String(args.tournamentId), api)) };
  },

  async tournament_standings(args, api) {
    const id = enc(args.tournamentId);
    const tournament = (await api(`/esports/tournaments/${id}`)) as TournamentApi;
    const names = namesOf(tournament);
    const name = (pid: string) => names[pid] ?? pid.slice(0, 8);

    if (tournament.bracketFormat === "swiss") {
      const r = (await api(`/esports/tournament/${id}/swiss`)) as {
        data: {
          round: number;
          totalRounds: number;
          complete: boolean;
          standings: { participantId: string; place: number; record: unknown; omw: number }[];
        };
      };
      return {
        bracketFormat: "swiss",
        round: r.data.round,
        totalRounds: r.data.totalRounds,
        complete: r.data.complete,
        standings: r.data.standings.map((s) => ({ ...s, name: name(s.participantId) })),
      };
    }
    if (tournament.bracketFormat === "round_robin") {
      return {
        bracketFormat: "round_robin",
        standings: await api(`/esports/matches/tournament/${id}/standings`),
      };
    }
    const box = (await api(`/esports/matches/tournament/${id}/bracket`)) as {
      complete: boolean;
      championId: string | null;
      standings: { participantId: string }[];
    };
    return {
      bracketFormat: tournament.bracketFormat,
      complete: box.complete,
      champion: box.championId ? name(box.championId) : null,
      standings: box.standings.map((s) => ({ ...s, name: name(s.participantId) })),
    };
  },

  async broadcast_sections(_args, api) {
    return api("/broadcast/sections");
  },

  async broadcast_create_match(args, api) {
    return api(
      "/broadcast/matches",
      "POST",
      compact({
        eventTitle: args.eventTitle,
        round: args.round,
        bestOf: args.bestOf,
        profileId: args.profileId,
        sideA: args.sideA,
        sideB: args.sideB,
      })
    );
  },
};

/**
 * Runs a domain tool. Returns `null` if the name is not a
 * domain one, so the server tries the generic ones.
 */
export async function runDomainTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiCall
): Promise<ToolResult | null> {
  const def = DOMAIN_TOOL_DEFINITIONS.find((d) => d.name === name);
  const manejador = MANEJADORES[name];
  if (!def || !manejador) return null;

  const invalid = validateArguments(def, args ?? {});
  if (invalid) return { content: [{ type: "text", text: invalid }], isError: true };

  try {
    const result = await manejador(args ?? {}, api);
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return { content: [{ type: "text", text: text }] };
  } catch (error) {
    // The API's message already says what is missing —unknown field, switched-off
    // section, round half-done—: it is returned as is, without wrapping it in another.
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}
