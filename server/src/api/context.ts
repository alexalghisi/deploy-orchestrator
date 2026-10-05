import type { DeploymentCommands } from '../app/deploymentCommands.js';
import type { PgCatalogRepository } from '../db/catalog.js';
import type { PgDeploymentRepository } from '../db/deployments.js';
import type { LogStore } from '../domain/logs.js';
import type { EventBus } from '../events/bus.js';
import type { FaultInjector } from '../fakes/faults.js';
import { createLoaders, type Loaders } from './loaders.js';

/** Long-lived dependencies, built once by the composition root. */
export interface ApiDeps {
  catalog: PgCatalogRepository;
  deployments: PgDeploymentRepository;
  commands: DeploymentCommands;
  logs: LogStore;
  bus: EventBus;
  /** Present only when the worker runs in the same process (the demo). */
  faults?: FaultInjector;
}

export interface Context extends ApiDeps {
  loaders: Loaders;
}

export function createContext(deps: ApiDeps): Context {
  return { ...deps, loaders: createLoaders(deps.catalog, deps.deployments) };
}
