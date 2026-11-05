/**
 * Example — the check-in desk of an in-person tournament
 * ============================================================================
 *
 * Copy the PATTERN, not the design. What matters in this file:
 *
 *   · `useCheckIn` refreshes on its own every 10 s while people arrive.
 *   · BOTH lists are offered: absent players to check in and present players to
 *     undo an extra click. Without the second one, a mistake at the desk is
 *     permanent.
 *   · Names come from `useBracket`, which already resolves them: check-in only
 *     returns participant ids.
 *   · `resolveMissing` works in two steps: first the plan, then `confirm`.
 */

import { useState } from "react";

import { useBracket, useCheckIn, type KitsudenConfig } from "../index.js";

export function CheckInDesk({
  config,
  tournamentId,
}: {
  config: KitsudenConfig;
  tournamentId: string;
}) {
  const { status: status, error, mark, undo, resolveMissing } = useCheckIn(config, tournamentId);
  const { names } = useBracket(config, tournamentId, { pollMs: 0 });
  const [warning, setWarning] = useState<string | null>(null);

  if (error) return <p role="alert">{error.message}</p>;
  if (!status) return <p>Loading…</p>;

  const name = (id: string) => names[id] ?? id.slice(0, 8);
  const attempt = (action: Promise<unknown>) => {
    setWarning(null);
    action.catch((e: Error) => setWarning(e.message));
  };

  const removeMissing = async () => {
    const plan = (await resolveMissing("drop")) as {
      plan: { participantIds: string[]; remaining: number };
    };
    const n = plan.plan.participantIds.length;
    if (n > 0 && window.confirm(`Remove ${n}? That would leave ${plan.plan.remaining}.`)) {
      await resolveMissing("drop", true);
    }
  };

  return (
    <div>
      <p>
        {status.summary.checkedIn} / {status.summary.total} present · check-in {status.state}
      </p>
      {warning && <p role="alert">{warning}</p>}

      <h3>Missing</h3>
      {status.summary.missingIds.map((id) => (
        <button key={id} type="button" onClick={() => attempt(mark(id))}>
          {name(id)}
        </button>
      ))}

      <h3>Present</h3>
      {status.summary.checkedInIds.map((id) => (
        <button key={id} type="button" title="Undo" onClick={() => attempt(undo(id))}>
          {name(id)} ✓
        </button>
      ))}

      <p>
        <button type="button" onClick={() => attempt(removeMissing())}>
          Remove absent players (before generating the bracket)</button>
      </p>
    </div>
  );
}
