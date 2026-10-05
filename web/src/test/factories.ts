import type { Deployment, DeploymentWithEvents } from '../graphql/types';

let n = 0;

export function deployment(overrides: Partial<Deployment> = {}): Deployment {
  n += 1;
  return {
    __typename: 'Deployment',
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    status: 'ACTIVE',
    commitSha: `${n}`.padStart(7, 'a'),
    commitMessage: `Commit ${n}`,
    image: `registry.local/api:${n}`,
    failureReason: null,
    isRollback: false,
    cancelRequested: false,
    canCancel: false,
    canRollback: false,
    createdAt: new Date(Date.UTC(2026, 9, 5, 10, n)).toISOString(),
    finishedAt: null,
    service: { __typename: 'Service', id: 'svc-1' },
    environment: { __typename: 'Environment', id: 'env-1' },
    ...overrides,
  };
}

export function withEvents(d: Deployment): DeploymentWithEvents {
  return { ...d, events: [{ __typename: 'DeploymentEvent', id: `${d.id}-1`, from: null, to: 'QUEUED', at: d.createdAt }] };
}
