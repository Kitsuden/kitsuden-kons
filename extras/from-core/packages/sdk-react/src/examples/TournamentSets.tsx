/**
 * Example — the sets of a tournament, to report from the desk
 * ============================================================================
 *
 * Copy the PATTERN, not the design. What matters in this file:
 *
 *   · `sets` already comes filtered: no byes, no resolved sets and no TBD
 *     slots. There is no need to filter it again.
 *   · Reporting uses `set.matchId` and the SIDE's `id`, which is a participant
 *     id. Sending the player's id is the most common mistake.
 *   · In Swiss, `nextStep` says when pairing is possible: the button only
 *     appears when no open sets remain, because the API rejects pairing while
 *     the round is half finished.
 */

import { useState } from "react";

import { useBracket, type KitsudenConfig } from "../index.js";

export function TournamentSets({
  config,
  tournamentId,
}: {
  config: KitsudenConfig;
  tournamentId: string;
}) {
  const { tournament, sets, nextStep, loading, error, report: report, pairNextRound } =
    useBracket(config, tournamentId);
  const [warning, setWarning] = useState<string | null>(null);

  if (loading) return <p>Loading…</p>;
  if (error) return <p role="alert">{error.message}</p>;
  if (!tournament) return null;

  const attempt = (action: Promise<unknown>) => {
    setWarning(null);
    action.catch((e: Error) => setWarning(e.message));
  };

  return (
    <div>
      <h2>{tournament.title}</h2>
      {warning && <p role="alert">{warning}</p>}

      {sets.length === 0 ? <p>There are no open sets.</p> : null}

      <ul>
        {sets.map((set) => (
          <li key={set.matchId}>
            <span>Round {set.turn}: </span>
            {set.sides.map((side) => (
              <button
                key={side.id}
                type="button"
                onClick={() => attempt(report(set.matchId, side.id))}
              >
                Wins {side.name}
              </button>
            ))}
          </li>
        ))}
      </ul>

      {nextStep === "emparejar" ? (
        <button type="button" onClick={() => attempt(pairNextRound())}>
          Pair next round</button>
      ) : null}
      {nextStep === "terminado" ? <p>The Swiss stage is over.</p> : null}
    </div>
  );
}
