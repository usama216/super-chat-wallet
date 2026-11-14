import { splitFee } from './fee-policy';

describe('splitFee (20% platform fee = 2000 bps)', () => {
  it('splits round amounts exactly', () => {
    expect(splitFee(100, 2000)).toEqual({ amount: 100, feeBps: 2000, creatorAmount: 80, platformFee: 20 });
    expect(splitFee(1000, 2000)).toMatchObject({ creatorAmount: 800, platformFee: 200 });
  });

  it('rounds the creator share down and gives the remainder to the platform', () => {
    expect(splitFee(7, 2000)).toMatchObject({ creatorAmount: 5, platformFee: 2 }); // 5.6 -> 5
    expect(splitFee(1, 2000)).toMatchObject({ creatorAmount: 0, platformFee: 1 }); // 0.8 -> 0
    expect(splitFee(9, 2000)).toMatchObject({ creatorAmount: 7, platformFee: 2 }); // 7.2 -> 7
  });

  it('never creates or loses a token, for every amount 1..10000', () => {
    for (let amount = 1; amount <= 10_000; amount++) {
      const { creatorAmount, platformFee } = splitFee(amount, 2000);
      expect(creatorAmount + platformFee).toBe(amount);
      expect(creatorAmount).toBeGreaterThanOrEqual(0);
      expect(platformFee).toBeGreaterThanOrEqual(0);
      // The platform never takes less than 20%, and never more than 20% + 1 token.
      expect(platformFee * 10_000).toBeGreaterThanOrEqual(amount * 2000);
      expect(platformFee).toBeLessThanOrEqual(Math.ceil(amount * 0.2));
    }
  });

  it('handles 0% and 100% fees', () => {
    expect(splitFee(55, 0)).toMatchObject({ creatorAmount: 55, platformFee: 0 });
    expect(splitFee(55, 10_000)).toMatchObject({ creatorAmount: 0, platformFee: 55 });
  });

  it('rejects invalid input', () => {
    expect(() => splitFee(0, 2000)).toThrow();
    expect(() => splitFee(-1, 2000)).toThrow();
    expect(() => splitFee(1.5, 2000)).toThrow();
    expect(() => splitFee(10, 10_001)).toThrow();
  });
});
