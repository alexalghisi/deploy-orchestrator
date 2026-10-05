import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { createPool, withTransaction, type Pool } from './pool.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    const sql = await readFile(MIGRATIONS_DIR + name, 'utf8');
    const ran = await withTransaction(pool, async (client) => {
      // serialises concurrent migrators (tests, a second process) on the same database
      await client.query('SELECT pg_advisory_xact_lock(4242)');
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (done.rowCount) return false;
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      return true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool(config.databaseUrl);
  migrate(pool)
    .then((applied) => console.log(applied.length ? `applied ${applied.join(', ')}` : 'up to date'))
    .finally(() => pool.end());
}
