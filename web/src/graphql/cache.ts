import { cacheExchange, type Cache, type CacheExchangeOpts, type Data } from '@urql/exchange-graphcache';
import type { Deployment } from './types';

let optimisticCounter = 0;
export const isOptimisticId = (id: string): boolean => id.startsWith('optimistic-');

function isDeployment(value: Data | null | undefined): value is Data & Deployment {
  return (
    !!value &&
    typeof value.id === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.service === 'object' &&
    value.service !== null &&
    typeof value.environment === 'object' &&
    value.environment !== null
  );
}

/**
 * Puts a deployment where the UI expects it: as its service's latest
 * deployment (if it is newer) and at the top of every first page of that
 * service's deployment list. Used for mutation results, optimistic results
 * and subscription events alike, so they cannot disagree.
 */
export function upsertDeployment(cache: Cache, deployment: Data | null | undefined): void {
  if (!isDeployment(deployment)) return;
  const deploymentKey = cache.keyOfEntity({ __typename: 'Deployment', id: deployment.id });
  const serviceKey = cache.keyOfEntity({ __typename: 'Service', id: deployment.service.id });
  if (!deploymentKey || !serviceKey) return;
  const environmentId = deployment.environment.id;

  const currentLatest = cache.resolve(serviceKey, 'latestDeployment', { environmentId });
  const currentCreatedAt = typeof currentLatest === 'string' ? cache.resolve(currentLatest, 'createdAt') : null;
  if (typeof currentCreatedAt !== 'string' || currentCreatedAt <= deployment.createdAt) {
    cache.link(serviceKey, 'latestDeployment', { environmentId }, deploymentKey);
  }

  for (const field of cache.inspectFields(serviceKey)) {
    if (field.fieldName !== 'deployments' || field.arguments?.environmentId !== environmentId || field.arguments?.after) continue;
    const connection = cache.resolve(serviceKey, field.fieldKey);
    if (typeof connection !== 'string') continue;
    const nodes = cache.resolve(connection, 'nodes');
    if (!Array.isArray(nodes)) continue;
    const keys = nodes.filter((n): n is string => typeof n === 'string');
    if (!keys.includes(deploymentKey)) cache.link(connection, 'nodes', [deploymentKey, ...keys]);
  }
}

function optimisticDeployment(fields: Partial<Deployment> & Pick<Deployment, 'service' | 'environment'>): Deployment {
  return {
    __typename: 'Deployment',
    id: `optimistic-${++optimisticCounter}`,
    status: 'QUEUED',
    commitSha: '',
    commitMessage: 'Queuing…',
    image: null,
    failureReason: null,
    isRollback: false,
    cancelRequested: false,
    canCancel: false,
    canRollback: false,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...fields,
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export const cacheConfig: CacheExchangeOpts = {
  keys: {
    DeploymentConnection: () => null,
    LogBatch: () => null,
    LogConnection: () => null,
    LogLine: () => null,
  },
  updates: {
    Mutation: {
      deployService: (result, _args, cache) => upsertDeployment(cache, result.deployService as Data),
      rollback: (result, _args, cache) => upsertDeployment(cache, result.rollback as Data),
    },
    Subscription: {
      deploymentUpdated: (result, _args, cache) => upsertDeployment(cache, result.deploymentUpdated as Data),
    },
  },
  optimistic: {
    deployService: (args) =>
      optimisticDeployment({
        service: { __typename: 'Service', id: str(args.serviceId) },
        environment: { __typename: 'Environment', id: str(args.environmentId) },
      }),
    cancelDeployment: (args) => ({ __typename: 'Deployment', id: str(args.id), cancelRequested: true, canCancel: false }),
    rollback: (args, cache) => {
      const target = cache.keyOfEntity({ __typename: 'Deployment', id: str(args.to) });
      const service = target ? cache.resolve(target, 'service') : null;
      const environment = target ? cache.resolve(target, 'environment') : null;
      const commitSha = target ? str(cache.resolve(target, 'commitSha')) : '';
      return optimisticDeployment({
        isRollback: true,
        commitSha,
        commitMessage: `Rollback to ${commitSha.slice(0, 7)}`,
        service: { __typename: 'Service', id: typeof service === 'string' ? str(cache.resolve(service, 'id')) : '' },
        environment: { __typename: 'Environment', id: typeof environment === 'string' ? str(cache.resolve(environment, 'id')) : '' },
      });
    },
  },
};

export const createCacheExchange = () => cacheExchange(cacheConfig);
