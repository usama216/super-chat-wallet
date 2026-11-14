// `npm run migrate`: apply migrations without starting the server (the app also migrates on boot).
import { Pool } from 'pg';
import { runMigrations } from './migrator';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    const applied = await runMigrations(pool, undefined, (m) => console.log(m));
    console.log(applied.length ? `Done (${applied.length} applied)` : 'Already up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
