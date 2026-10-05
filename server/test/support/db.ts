import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import type { Pool } from '../../src/db/pool.js';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://synckit:synckit@localhost:5432/deployorch_test';

export interface TestDb {
  pool: Pool;
  schema: string;
  url: string;
  drop(): Promise<void>;
}

/**
 * Every test file gets its own schema in the test database, so files can run
 * in parallel against real Postgres without stepping on each other.
 */
export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const url = `${TEST_URL}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await migrate(pool);
  return {
    pool,
    schema,
    url,
    async drop() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
