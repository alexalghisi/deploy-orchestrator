import DataLoader from 'dataloader';
import type { PgCatalogRepository } from '../db/catalog.js';
import type { PgDeploymentRepository } from '../db/deployments.js';
import type { Deployment, DeploymentEvent, Environment, Project, Service } from '../domain/types.js';

function byId<T extends { id: string }>(ids: readonly string[], rows: T[]): Array<T | null> {
  const map = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => map.get(id) ?? null);
}

function groupBy<T>(keys: readonly string[], rows: T[], keyOf: (row: T) => string): T[][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return keys.map((k) => map.get(k) ?? []);
}

/** Per-request batching, so a canvas of N services costs a constant number of queries. */
export function createLoaders(catalog: PgCatalogRepository, deployments: PgDeploymentRepository) {
  return {
    project: new DataLoader<string, Project | null>(async (ids) => byId(ids, await catalog.projectsById(ids))),
    service: new DataLoader<string, Service | null>(async (ids) => byId(ids, await catalog.servicesById(ids))),
    environment: new DataLoader<string, Environment | null>(async (ids) => byId(ids, await catalog.environmentsById(ids))),
    deployment: new DataLoader<string, Deployment | null>(async (ids) => byId(ids, await deployments.findMany(ids))),
    servicesByProject: new DataLoader<string, Service[]>(async (ids) =>
      groupBy(ids, await catalog.servicesByProject(ids), (s) => s.projectId),
    ),
    environmentsByProject: new DataLoader<string, Environment[]>(async (ids) =>
      groupBy(ids, await catalog.environmentsByProject(ids), (e) => e.projectId),
    ),
    events: new DataLoader<string, DeploymentEvent[]>(async (ids) =>
      groupBy(ids, await deployments.events(ids), (e) => e.deploymentId),
    ),
    /** Keyed by `${serviceId}:${environmentId}`; batches one query per environment. */
    latestDeployment: new DataLoader<string, Deployment | null>(async (keys) => {
      const byEnv = new Map<string, string[]>();
      for (const key of keys) {
        const [serviceId = '', environmentId = ''] = key.split(':');
        byEnv.set(environmentId, [...(byEnv.get(environmentId) ?? []), serviceId]);
      }
      const found = new Map<string, Deployment>();
      await Promise.all(
        [...byEnv].map(async ([environmentId, serviceIds]) => {
          for (const d of await deployments.latestForServices(serviceIds, environmentId)) {
            found.set(`${d.serviceId}:${d.environmentId}`, d);
          }
        }),
      );
      return keys.map((k) => found.get(k) ?? null);
    }),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;

/**
 * A subscription keeps one context for its whole life, so its loaders would
 * serve the first event's data forever. Cleared before each event.
 */
export function clearLoaders(loaders: Loaders): void {
  for (const loader of Object.values(loaders)) loader.clearAll();
}
