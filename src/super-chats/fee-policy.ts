// Fee split in integer math. The creator share rounds down and the platform takes the rest,
// so the two parts always add up to the amount (7 tokens at 20% -> creator 5, platform 2).
// Computing the fee as "amount - creator share" instead of rounding both parts separately
// is what guarantees no token is created or lost.
export interface FeeSplit {
  amount: number;
  feeBps: number;
  creatorAmount: number;
  platformFee: number;
}

export function splitFee(amount: number, feeBps: number): FeeSplit {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`amount must be a positive integer, got ${amount}`);
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error(`feeBps must be an integer in [0, 10000], got ${feeBps}`);
  }
  const creatorAmount = Math.floor((amount * (10_000 - feeBps)) / 10_000);
  return { amount, feeBps, creatorAmount, platformFee: amount - creatorAmount };
}
