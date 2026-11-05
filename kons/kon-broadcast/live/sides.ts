/**
 * Mapping between the MATCH's sides and the GAME's
 * ============================================================================
 *
 * In competition sides are swapped between games: whoever was blue in the
 * first may be red in the second. There are then two coordinate
 * systems and confusing them is this kon's expensive failure:
 *
 *   · **Match side** — A and B. It is who is who on the scoreboard and
 *     in the bracket. It does not change over the whole broadcast.
 *   · **Game side** — blue and red. It is where THIS game is
 *     being played. It changes.
 *
 * `sideAFirst` on the game row says which is which. Everything that translates
 * between the two systems lives here, and only here: repeated in the graphic, in the
 * panel and in the post-game, one of the three would end up painting the crests
 * swapped.
 *
 * The blue/red vocabulary is used inside the game on purpose: in a MOBA
 * they are literal sides of the map, not a metaphor. Outside this section everything
 * speaks of side A and side B.
 */

import type { BroadcastSide } from "../broadcast.schema.js";

import type { SeriesHistory } from "./draft.js";

/** Which match side plays on each side of this game. */
export function sidesOf(
  match: { sideA: BroadcastSide; sideB: BroadcastSide },
  game: { sideAFirst: boolean }
): { blue: BroadcastSide; red: BroadcastSide } {
  return game.sideAFirst
    ? { blue: match.sideA, red: match.sideB }
    : { blue: match.sideB, red: match.sideA };
}

/**
 * Converts a draft result (by GAME SIDE) to match
 * keys.
 *
 * It is the step to take when SAVING, and the one that keeps Fearless in `team`
 * mode from locking characters to the opposite side from the second game on.
 */
export function toSeriesKeyed(bySide: SeriesHistory, sideAFirst: boolean): SeriesHistory {
  return sideAFirst ? bySide : { blue: bySide.red, red: bySide.blue };
}

/**
 * The inverse: from match keys to the side each occupies in THIS
 * game. It is what the draft in progress needs to know what is locked
 * for whoever has the turn.
 */
export function toSideKeyed(bySeries: SeriesHistory, sideAFirst: boolean): SeriesHistory {
  return sideAFirst ? bySeries : { blue: bySeries.red, red: bySeries.blue };
}

/**
 * Accumulated history of the match, in match keys.
 *
 * Games already store `drafted` normalized, so here it is only summed. If
 * the normalization were done at this point, every consumer would have to
 * remember to pass each game's `sideAFirst` — and one would forget.
 */
export function seriesHistory(games: { drafted: SeriesHistory | null }[]): SeriesHistory {
  return games.reduce<SeriesHistory>(
    (acc, g) => ({
      blue: [...acc.blue, ...(g.drafted?.blue ?? [])],
      red: [...acc.red, ...(g.drafted?.red ?? [])],
    }),
    { blue: [], red: [] }
  );
}
