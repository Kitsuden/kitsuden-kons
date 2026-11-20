/**
 * The table's realtime relay: channel names, what travels, who may listen
 * ============================================================================
 *
 * A two-player table stays in sync through the host's WebSocket (`/api/realtime`). The kon
 * broadcasts on its own namespace, `kon:cardsim:…`, which the host only lets a socket hear after
 * asking the kon (`ctx.realtime.channels`).
 *
 * ── WHAT TRAVELS ───────────────────────────────────────────────────────────
 *
 * "Something happened, and this is its number" — never the action, a card, a deck or an image.
 * Each client then asks for ITS OWN view (`get-session`), so every secret stays behind `viewFor`
 * on the server, spectators included. The relay is zero-asset by construction:
 * `tests/unit/cardsim-relay.test.ts` plays a whole game and checks every message.
 *
 * The one message that carries a link is `sourceShared`: a player explicitly offers THEIR link
 * template or community pack to the other players. It goes on the players-only channel, and the
 * receiver has to accept it by hand.
 *
 * Pure (no Node, no DOM): the server and the browser client both import it.
 */

/** Session ids are cuid2: letters and digits. Anything else is not a table. */
const SESSION_ID = "[A-Za-z0-9_-]{1,64}";
const TABLE = new RegExp(`^session:(${SESSION_ID})$`);
const PLAYERS = new RegExp(`^session:(${SESSION_ID}):players$`);

/** The kon's realtime namespace (`kon-cardsim` → `kon:cardsim:`). */
export const CHANNEL_PREFIX = "kon:cardsim:";

/** Everything about a table that players and spectators may hear. */
export const tableChannel = (sessionId: string) => `${CHANNEL_PREFIX}session:${sessionId}`;
/** What only the seated players hear (shared image links). */
export const playersChannel = (sessionId: string) => `${CHANNEL_PREFIX}session:${sessionId}:players`;

export type SharedSource = { kind: "template" | "pack"; label: string; url: string };

export type TableEvent =
  | { type: "join"; seat: number; full: boolean }
  | { type: "action"; actionCount: number; actionType: string; by: number; finished: boolean }
  | { type: "timeout"; seat: number }
  | { type: "undoRequest"; by: number; toActionCount: number }
  | { type: "undo"; toActionCount: number }
  | { type: "undoCancelled" }
  | { type: "rematch"; sessionId: string }
  | { type: "sourceShared"; by: number; source: SharedSource };

/** Every key each event may carry. The relay test holds the server to it. */
export const EVENT_KEYS: Record<TableEvent["type"], readonly string[]> = {
  join: ["type", "seat", "full"],
  action: ["type", "actionCount", "actionType", "by", "finished"],
  timeout: ["type", "seat"],
  undoRequest: ["type", "by", "toActionCount"],
  undo: ["type", "toActionCount"],
  undoCancelled: ["type"],
  rematch: ["type", "sessionId"],
  sourceShared: ["type", "by", "source"],
};

/**
 * A message from the socket as a table event, or `null`. The client never trusts a frame's shape:
 * an unknown type or an extra key is dropped, not acted on.
 */
export function parseTableEvent(data: unknown): TableEvent | null {
  if (!data || typeof data !== "object") return null;
  const event = data as Record<string, unknown>;
  const type = event.type;
  if (typeof type !== "string" || !Object.hasOwn(EVENT_KEYS, type)) return null;
  const allowed = EVENT_KEYS[type as TableEvent["type"]];
  if (Object.keys(event).some((k) => !allowed.includes(k))) return null;
  if (type === "sourceShared") {
    const src = event.source as Record<string, unknown> | undefined;
    if (
      !src ||
      (src.kind !== "template" && src.kind !== "pack") ||
      typeof src.label !== "string" ||
      typeof src.url !== "string"
    ) {
      return null;
    }
  }
  return event as unknown as TableEvent;
}

interface SessionLike {
  seats: (string | null)[];
  allowSpectators: boolean;
}

/**
 * Whether `user` may listen to `rest` (the part after `kon:cardsim:`).
 *
 *   · `session:<id>`          — a seated player, or anyone if the room admits spectators (the same
 *                               rule as `get-session`);
 *   · `session:<id>:players`  — seated players only.
 *
 * Anything else is denied.
 */
export async function authorizeTableChannel(
  rest: string,
  user: { id: string | null; role: string | null },
  findSession: (id: string) => Promise<SessionLike | null | undefined>
): Promise<boolean> {
  const players = PLAYERS.exec(rest);
  const table = players ? null : TABLE.exec(rest);
  const id = players?.[1] ?? table?.[1];
  if (!id) return false;
  const session = await findSession(id);
  if (!session) return false;
  const seated = !!user.id && session.seats.includes(user.id);
  if (players) return seated;
  return seated || session.allowSpectators;
}
