import { DEPLOYMENT_STATUSES, isInFlight } from '../../domain/deploymentStatus.js';
import type { Deployment, DeploymentEvent } from '../../domain/types.js';
import { DomainError } from '../../app/errors.js';
import { builder } from '../builder.js';
import { EnvironmentRef, ServiceRef } from './catalog.js';
import { LogConnectionRef } from './logs.js';

export const DeploymentStatusEnum = builder.enumType('DeploymentStatus', { values: DEPLOYMENT_STATUSES });

export const DeploymentRef = builder.objectRef<Deployment>('Deployment');
const DeploymentEventRef = builder.objectRef<DeploymentEvent>('DeploymentEvent');

export interface DeploymentConnection {
  nodes: Deployment[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export const DeploymentConnectionRef = builder.objectRef<DeploymentConnection>('DeploymentConnection').implement({
  fields: (t) => ({
    nodes: t.field({ type: [DeploymentRef], resolve: (c) => c.nodes }),
    endCursor: t.exposeString('endCursor', { nullable: true }),
    hasNextPage: t.exposeBoolean('hasNextPage'),
  }),
});

DeploymentEventRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    from: t.field({ type: DeploymentStatusEnum, nullable: true, resolve: (e) => e.from }),
    to: t.field({ type: DeploymentStatusEnum, resolve: (e) => e.to }),
    at: t.field({ type: 'DateTime', resolve: (e) => e.at }),
  }),
});

DeploymentRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    status: t.field({ type: DeploymentStatusEnum, resolve: (d) => d.status }),
    commitSha: t.exposeString('commitSha'),
    commitMessage: t.exposeString('commitMessage'),
    image: t.exposeString('image', { nullable: true }),
    failureReason: t.exposeString('failureReason', { nullable: true }),
    isRollback: t.boolean({ resolve: (d) => d.rollbackOf !== null }),
    cancelRequested: t.boolean({ resolve: (d) => d.cancelRequestedAt !== null }),
    // the client asks the server what is allowed instead of re-implementing the state machine
    canCancel: t.boolean({ resolve: (d) => isInFlight(d.status) && d.cancelRequestedAt === null }),
    canRollback: t.boolean({ resolve: (d) => d.status === 'REMOVED' && d.image !== null }),
    createdAt: t.field({ type: 'DateTime', resolve: (d) => d.createdAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (d) => d.updatedAt }),
    finishedAt: t.field({ type: 'DateTime', nullable: true, resolve: (d) => d.finishedAt }),
    rollbackOf: t.field({
      type: DeploymentRef,
      nullable: true,
      resolve: (d, _, ctx) => (d.rollbackOf ? ctx.loaders.deployment.load(d.rollbackOf) : null),
    }),
    service: t.field({ type: ServiceRef, resolve: (d, _, ctx) => required(ctx.loaders.service.load(d.serviceId), 'Service') }),
    environment: t.field({
      type: EnvironmentRef,
      resolve: (d, _, ctx) => required(ctx.loaders.environment.load(d.environmentId), 'Environment'),
    }),
    events: t.field({ type: [DeploymentEventRef], resolve: (d, _, ctx) => ctx.loaders.events.load(d.id) }),
    logs: t.field({
      type: LogConnectionRef,
      description: 'Oldest first. Pass endCursor back as `after` to continue.',
      args: { first: t.arg.int({ defaultValue: 500 }), after: t.arg.string() },
      resolve: async (d, args, ctx) => {
        const limit = Math.min(Math.max(args.first ?? 500, 1), 5000);
        const page = await ctx.logs.page(d.id, { after: args.after ?? null, limit: limit + 1 });
        const lines = page.lines.slice(0, limit);
        return { lines, endCursor: lines.at(-1)?.seq ?? args.after ?? null, hasMore: page.lines.length > limit };
      },
    }),
  }),
});

builder.queryField('deployment', (t) =>
  t.field({
    type: DeploymentRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_, args, ctx) => ctx.loaders.deployment.load(String(args.id)),
  }),
);

async function required<T>(value: Promise<T | null>, what: string): Promise<T> {
  const resolved = await value;
  if (resolved === null) throw new DomainError('NOT_FOUND', `${what} not found`);
  return resolved;
}

export function encodeDeploymentCursor(d: Deployment): string {
  return Buffer.from(`${d.createdAt.toISOString()}|${d.id}`).toString('base64url');
}

export function decodeDeploymentCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new DomainError('INVALID_INPUT', 'Malformed cursor');
  }
  return { createdAt, id };
}
