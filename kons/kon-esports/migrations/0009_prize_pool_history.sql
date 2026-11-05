-- 0009 — Prize pool history
-- ============================================================================
--
-- Storing only the current figure wastes the one interesting thing about a
-- crowdfunded pool: **that it goes up**. A number sitting still on screen is a
-- fact; the same number climbing is what makes people chip in.
--
-- The history gives three things a single column cannot:
--   · The overlay's animated counter ("$212 → $237").
--   · "Up $50 in the last hour", which is the message that grows a pot.
--   · The curve, which is content for the post afterwards.

CREATE TABLE IF NOT EXISTS esports_prize_pool_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES esports_tournaments(id) ON DELETE CASCADE,

  -- In CENTS, as an integer. Same as the tournament's column, and for the same
  -- reason: it is money someone has paid and it is shown on screen.
  cents INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  contributors INTEGER,

  /*
   * Where the figure came from. Always `matcherino` today, but a pot can also
   * come from a spreadsheet or from kon-payments, and mixing sources without
   * being able to tell them apart would make the curve unreadable.
   */
  source VARCHAR(20) NOT NULL DEFAULT 'matcherino',

  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The overlay's query: "the latest N for this tournament".
CREATE INDEX IF NOT EXISTS prize_snapshots_tournament_idx
  ON esports_prize_pool_snapshots (tournament_id, captured_at DESC);
