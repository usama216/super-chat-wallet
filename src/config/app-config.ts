// Config is read once at startup and validated, so a bad value fails the boot
// instead of failing later in the middle of a request.
export interface AppConfig {
  databaseUrl: string;
  port: number;
  /** Platform fee in basis points (2000 = 20%), keeps the fee math in integers. */
  platformFeeBps: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: requireEnv('DATABASE_URL'),
    port: intEnv('PORT', 3000, 1, 65535),
    platformFeeBps: intEnv('PLATFORM_FEE_BPS', 2000, 0, 10000),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
