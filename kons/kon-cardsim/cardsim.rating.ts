/**
 * CardSim — Elo rating
 * ============================================================================
 *
 * Classic Elo, with a single decision that deserves explanation: K decreases with
 * games played. A new account moves quickly until it finds its
 * place (K=40) and a veteran barely oscillates (K=16). With a fixed K one of two
 * things happens: either newcomers take a hundred games to settle, or veterans take
 * 30-point swings from one bad night.
 *
 * A draw counts 0.5, which is what makes Elo work in games where
 * the game can end with no winner (double KOs, time out).
 */

/** Games after which an account is considered settled. */
const SETTLED_AT = 30;

export function kFactor(gamesPlayed: number): number {
  if (gamesPlayed < 10) return 40;
  if (gamesPlayed < SETTLED_AT) return 24;
  return 16;
}

export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

/**
 * New ratings after a game. `score` is the FIRST's: 1 wins, 0 loses,
 * 0.5 draw.
 *
 * It is rounded to the nearest integer and the full pair is returned because
 * both sides have to be written in the same transaction: if only the
 * winner were updated, the system's total points would grow endlessly.
 */
export function applyElo(
  a: { rating: number; games: number },
  b: { rating: number; games: number },
  score: number
): { a: number; b: number } {
  const expected = expectedScore(a.rating, b.rating);
  return {
    a: Math.round(a.rating + kFactor(a.games) * (score - expected)),
    b: Math.round(b.rating + kFactor(b.games) * (1 - score - (1 - expected))),
  };
}
