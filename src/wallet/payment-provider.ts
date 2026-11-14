import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

// Boundary to a real payment provider. Contract: charge() is idempotent by idempotencyKey,
// so retrying returns the original result and never charges twice (Stripe supports this).
// We pass our purchase id as the key.
export interface ChargeRequest {
  idempotencyKey: string;
  userId: string;
  amount: number;
}

export type ChargeResult =
  | { status: 'succeeded'; chargeId: string }
  | { status: 'declined'; reason: string };

export interface PaymentProvider {
  charge(req: ChargeRequest): Promise<ChargeResult>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** Always approves; remembers results per key like a real provider would. */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  private readonly charges = new Map<string, ChargeResult>();

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const existing = this.charges.get(req.idempotencyKey);
    if (existing) return existing;
    const result: ChargeResult = { status: 'succeeded', chargeId: `mock_ch_${randomUUID()}` };
    this.charges.set(req.idempotencyKey, result);
    return result;
  }
}
