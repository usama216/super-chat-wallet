// Config is read once at startup and validated, so a bad value fails the boot
// instead of failing later in the middle of a request.
export interface AppConfig {
  databaseUrl: string;
  port: number;
  /** Platform fee in basis points (2000 = 20%), keeps the fee math in integers. */
  platformFeeBps: number;
  /** Max pg connections per process. Kept small on serverless, where many instances may run. */
  dbPoolMax: number;
}

/**
 * Vercel sets VERCEL=1 in its runtime. There the app runs as a serverless function: no
 * long-lived connections, so the WebSocket gateway and the LISTEN connection are disabled.
 */
export const IS_SERVERLESS = Boolean(process.env.VERCEL);

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
    dbPoolMax: intEnv('DB_POOL_MAX', IS_SERVERLESS ? 2 : 20, 1, 100),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
