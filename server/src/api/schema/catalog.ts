import type { Environment, Project, Service } from '../../domain/types.js';
import { builder } from '../builder.js';
import { DeploymentConnectionRef, DeploymentRef, decodeDeploymentCursor, encodeDeploymentCursor } from './deployment.js';

export const ProjectRef = builder.objectRef<Project>('Project');
export const EnvironmentRef = builder.objectRef<Environment>('Environment');
export const ServiceRef = builder.objectRef<Service>('Service');

ProjectRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    services: t.field({ type: [ServiceRef], resolve: (p, _, ctx) => ctx.loaders.servicesByProject.load(p.id) }),
    environments: t.field({ type: [EnvironmentRef], resolve: (p, _, ctx) => ctx.loaders.environmentsByProject.load(p.id) }),
  }),
});

EnvironmentRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
  }),
});

ServiceRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    repo: t.exposeString('repo'),
    latestDeployment: t.field({
      type: DeploymentRef,
      nullable: true,
      args: { environmentId: t.arg.id({ required: true }) },
      resolve: (s, args, ctx) => ctx.loaders.latestDeployment.load(`${s.id}:${args.environmentId}`),
    }),
    deployments: t.field({
      type: DeploymentConnectionRef,
      description: 'Newest first.',
      args: {
        environmentId: t.arg.id({ required: true }),
        first: t.arg.int({ defaultValue: 20 }),
        after: t.arg.string(),
      },
      resolve: async (s, args, ctx) => {
        const first = Math.min(Math.max(args.first ?? 20, 1), 100);
        const before = args.after ? decodeDeploymentCursor(args.after) : undefined;
        const rows = await ctx.deployments.listForService(s.id, String(args.environmentId), first + 1, before);
        const nodes = rows.slice(0, first);
        const last = nodes.at(-1);
        return { nodes, endCursor: last ? encodeDeploymentCursor(last) : null, hasNextPage: rows.length > first };
      },
    }),
  }),
});

builder.queryFields((t) => ({
  projects: t.field({ type: [ProjectRef], resolve: (_, __, ctx) => ctx.catalog.projects() }),
  project: t.field({
    type: ProjectRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_, args, ctx) => ctx.loaders.project.load(String(args.id)),
  }),
  service: t.field({
    type: ServiceRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_, args, ctx) => ctx.loaders.service.load(String(args.id)),
  }),
}));
