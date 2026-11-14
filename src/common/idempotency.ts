import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Request } from 'express';

// The client sends one Idempotency-Key per intended operation and reuses it on retries.
// The key is stored in a unique column on the row the operation creates (purchase, super
// chat, payout), so a retry finds the existing row instead of charging again. Because the
// guarantee comes from the database, it holds across restarts and multiple instances.

const KEY_RE = /^[A-Za-z0-9_\-:.]{1,255}$/;

/** Reads and validates the Idempotency-Key header. Required on money-moving requests. */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const key = ctx.switchToHttp().getRequest<Request>().header('idempotency-key');
  if (!key) {
    throw new BadRequestException('Idempotency-Key header is required');
  }
  if (!KEY_RE.test(key)) {
    throw new BadRequestException(
      'Idempotency-Key must be 1-255 characters of letters, digits, "_", "-", ":" or "."',
    );
  }
  return key;
});

/** Order-independent fingerprint of a request body. */
export function requestHash(body: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(body)
      .sort()
      .map((k) => [k, body[k]]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

// Same key with a different body is a client bug. Neither replaying the old result nor
// running the new request would be correct, so reject it (same as Stripe).
export function assertSameRequest(storedHash: string, incomingHash: string): void {
  if (storedHash !== incomingHash) {
    throw new UnprocessableEntityException(
      'This Idempotency-Key was already used with a different request body',
    );
  }
}
