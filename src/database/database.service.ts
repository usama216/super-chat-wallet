import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/app-config';

// pg returns BIGINT as a string by default. Our amounts are bounded well below 2^53, so we
// parse them to numbers, but throw rather than silently lose precision if one ever isn't safe.
types.setTypeParser(types.builtins.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`BIGINT value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return parsed;
});

/** The pool or a client inside a transaction. Lets the caller decide the transaction scope. */
export type Queryable = Pick<PoolClient, 'query'>;

// Serialization failure / deadlock: Postgres rolled the transaction back, so it's safe to rerun.
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);
const MAX_TX_ATTEMPTS = 3;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
    this.pool.on('error', (err) => this.logger.error(`Idle pg client error: ${err.message}`));
  }

  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<R>(text, params);
  }

  /**
   * Runs `work` in a single transaction: commit on success, rollback on any error.
   *
   * We stay on READ COMMITTED and take explicit row locks (SELECT ... FOR UPDATE) where
   * ordering matters, instead of using SERIALIZABLE. The locks make it obvious in the code
   * what is serialized, and contention means waiting rather than retry storms.
   */
  async transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (err as { code?: string }).code;
        if (code && RETRYABLE_PG_CODES.has(code) && attempt < MAX_TX_ATTEMPTS) {
          this.logger.warn(`Retrying transaction after ${code} (attempt ${attempt})`);
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
