import type { Deployment } from '../../domain/types.js';
import type { DeploymentChanged } from '../../events/bus.js';
import { tailLogs } from '../../logs/tailLogs.js';
import type { Context } from '../context.js';
import { builder } from '../builder.js';
import { DeploymentRef } from './deployment.js';
import { LogBatchRef } from './logs.js';

async function* deploymentUpdates(
  ctx: Context,
  matches: (event: DeploymentChanged) => boolean,
): AsyncGenerator<Deployment> {
  const events = ctx.bus.subscribe('deploymentChanged');
  try {
    for await (const event of events) {
      if (!matches(event)) continue;
      // the event is a pointer; read the row so clients always get a complete, current deployment
      const deployment = await ctx.deployments.find(event.id);
      if (deployment) yield deployment;
    }
  } finally {
    await events.return();
  }
}

builder.subscriptionFields((t) => ({
  deploymentUpdated: t.field({
    type: DeploymentRef,
    description: 'Every change to a deployment in one environment of a project.',
    args: { projectId: t.arg.id({ required: true }), environmentId: t.arg.id({ required: true }) },
    subscribe: (_, args, ctx) =>
      deploymentUpdates(ctx, (e) => e.projectId === String(args.projectId) && e.environmentId === String(args.environmentId)),
    resolve: (deployment) => deployment,
  }),
  deploymentLogs: t.field({
    type: LogBatchRef,
    description: 'History after `after` (or from the start) in pages, then new lines as they are written.',
    args: { deploymentId: t.arg.id({ required: true }), after: t.arg.string() },
    subscribe: (_, args, ctx) => tailLogs(ctx.logs, ctx.bus, String(args.deploymentId), args.after ?? null),
    resolve: (batch) => batch,
  }),
}));
