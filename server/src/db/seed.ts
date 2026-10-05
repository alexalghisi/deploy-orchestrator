import { config } from '../config.js';
import { PgCatalogRepository } from './catalog.js';
import { migrate } from './migrate.js';
import { createPool, type Pool } from './pool.js';

const SERVICES = [
  ['api', 'github.com/acme/api'],
  ['web', 'github.com/acme/web'],
  ['worker', 'github.com/acme/worker'],
  ['billing', 'github.com/acme/billing'],
] as const;

/** Creates the demo project unless it already exists. */
export async function seed(pool: Pool): Promise<void> {
  const catalog = new PgCatalogRepository(pool);
  if ((await catalog.projects()).some((p) => p.name === 'acme-shop')) return;
  const project = await catalog.createProject('acme-shop', ['production', 'staging']);
  for (const [name, repo] of SERVICES) await catalog.createService(project.id, name, repo);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool(config.databaseUrl);
  migrate(pool)
    .then(() => seed(pool))
    .then(() => console.log('seeded acme-shop'))
    .finally(() => pool.end());
}
