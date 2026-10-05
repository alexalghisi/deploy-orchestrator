import { PgCatalogRepository } from '../../src/db/catalog.js';
import type { Pool } from '../../src/db/pool.js';
import type { Environment, Project, Service } from '../../src/domain/types.js';

export interface Fixture {
  project: Project;
  service: Service;
  production: Environment;
  staging: Environment;
}

let counter = 0;

export async function seedProject(pool: Pool, name = `proj-${++counter}`): Promise<Fixture> {
  const catalog = new PgCatalogRepository(pool);
  const project = await catalog.createProject(name, ['production', 'staging']);
  const service = await catalog.createService(project.id, 'api', 'github.com/acme/api');
  const envs = await catalog.environmentsByProject([project.id]);
  const production = envs.find((e) => e.name === 'production')!;
  const staging = envs.find((e) => e.name === 'staging')!;
  return { project, service, production, staging };
}

export const sha = (n: number): string => n.toString(16).padStart(7, '0');
