// Keep these in sync with the CHECK constraints in migrations/001_init.sql.
export type UserAccountType = 'USER_WALLET' | 'CREATOR_EARNINGS';
export type SystemAccountType = 'PLATFORM_FEES' | 'PAYMENT_CLEARING' | 'PAYOUTS_IN_TRANSIT';
export type AccountType = UserAccountType | SystemAccountType;

export type LedgerKind =
  | 'PURCHASE'
  | 'SUPER_CHAT'
  | 'SUPER_CHAT_REVERSAL'
  | 'PAYOUT_REQUEST'
  | 'PAYOUT_PAID'
  | 'PAYOUT_REJECTED';

/** Signed amount: positive = debit, negative = credit. Build with debit()/credit(). */
export interface PostingLine {
  accountId: string;
  amount: number;
}

export function debit(accountId: string, amount: number): PostingLine {
  return { accountId, amount: Math.abs(amount) };
}

export function credit(accountId: string, amount: number): PostingLine {
  return { accountId, amount: -Math.abs(amount) };
}
