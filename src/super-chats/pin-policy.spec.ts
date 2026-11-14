import { PIN_TIERS, pinDurationSeconds } from './pin-policy';

describe('pinDurationSeconds', () => {
  it('maps amounts to their tier', () => {
    expect(pinDurationSeconds(1)).toBe(30);
    expect(pinDurationSeconds(49)).toBe(30);
    expect(pinDurationSeconds(50)).toBe(120);
    expect(pinDurationSeconds(200)).toBe(300);
    expect(pinDurationSeconds(999)).toBe(300);
    expect(pinDurationSeconds(1_000)).toBe(1_800);
    expect(pinDurationSeconds(1_000_000)).toBe(3_600);
  });

  it('a bigger amount is never pinned for less time', () => {
    let previous = 0;
    for (let amount = 1; amount <= 10_000; amount++) {
      const seconds = pinDurationSeconds(amount);
      expect(seconds).toBeGreaterThanOrEqual(previous);
      previous = seconds;
    }
  });

  it('tiers are sorted and strictly increasing', () => {
    for (let i = 1; i < PIN_TIERS.length; i++) {
      expect(PIN_TIERS[i].minAmount).toBeGreaterThan(PIN_TIERS[i - 1].minAmount);
      expect(PIN_TIERS[i].seconds).toBeGreaterThan(PIN_TIERS[i - 1].seconds);
    }
  });
});
