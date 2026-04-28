// Standard ELO with K=32 for all players. Refine later (e.g. lower K for
// established players) once we have a meaningful number of games.
const K = 32;

export type EloOutcome = "white_wins" | "black_wins" | "draw";

export function computeNewRatings(
  whiteRating: number,
  blackRating: number,
  outcome: EloOutcome,
): {
  whiteRating: number;
  blackRating: number;
  whiteDelta: number;
  blackDelta: number;
} {
  const expectedWhite =
    1 / (1 + Math.pow(10, (blackRating - whiteRating) / 400));
  const actualWhite = outcome === "white_wins" ? 1 : outcome === "draw" ? 0.5 : 0;

  const whiteDelta = Math.round(K * (actualWhite - expectedWhite));
  const blackDelta = -whiteDelta;

  return {
    whiteRating: whiteRating + whiteDelta,
    blackRating: blackRating + blackDelta,
    whiteDelta,
    blackDelta,
  };
}
