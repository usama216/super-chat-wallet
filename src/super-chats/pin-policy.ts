// Bigger amounts stay pinned longer. Tiers rather than a linear formula, so a huge amount
// can't pin a message for a day and push everyone else out. The end time is computed on the
// server and stored, so every viewer sees the same thing.
export interface PinTier {
  minAmount: number;
  seconds: number;
}

/** Ascending by minAmount; the highest tier that matches wins. */
export const PIN_TIERS: readonly PinTier[] = [
  { minAmount: 1, seconds: 30 },
  { minAmount: 50, seconds: 2 * 60 },
  { minAmount: 200, seconds: 5 * 60 },
  { minAmount: 1_000, seconds: 30 * 60 },
  { minAmount: 5_000, seconds: 60 * 60 },
];

export function pinDurationSeconds(amount: number, tiers: readonly PinTier[] = PIN_TIERS): number {
  let seconds = 0;
  for (const tier of tiers) {
    if (amount >= tier.minAmount) seconds = tier.seconds;
  }
  return seconds;
}
