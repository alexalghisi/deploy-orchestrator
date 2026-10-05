import { DomainError } from '../../app/errors.js';
import { FAULT_TARGETS } from '../../fakes/faults.js';
import { builder } from '../builder.js';
import { DeploymentRef } from './deployment.js';

builder.mutationFields((t) => ({
  deployService: t.field({
    type: DeploymentRef,
    description: 'Queues a deployment. A newer deployment for the same service and environment supersedes it.',
    args: {
      serviceId: t.arg.id({ required: true }),
      environmentId: t.arg.id({ required: true }),
      commitSha: t.arg.string({ description: 'Defaults to the head of the default branch.' }),
    },
    resolve: (_, args, ctx) =>
      ctx.commands.deploy({
        serviceId: String(args.serviceId),
        environmentId: String(args.environmentId),
        commitSha: args.commitSha ?? null,
      }),
  }),
  cancelDeployment: t.field({
    type: DeploymentRef,
    description: 'Requests cancellation. The deployment becomes CANCELLED once anything it provisioned is cleaned up.',
    args: { id: t.arg.id({ required: true }) },
    resolve: (_, args, ctx) => ctx.commands.cancel(String(args.id)),
  }),
  rollback: t.field({
    type: DeploymentRef,
    description: 'Creates a new deployment that runs the image of an earlier, previously live deployment.',
    args: { to: t.arg.id({ required: true }) },
    resolve: (_, args, ctx) => ctx.commands.rollback(String(args.to)),
  }),
  injectFault: t.boolean({
    description: 'Demo only: make the next call(s) to a fake service fail.',
    args: {
      target: t.arg({ type: builder.enumType('FaultTarget', { values: FAULT_TARGETS }), required: true }),
      kind: t.arg({ type: builder.enumType('FaultKind', { values: ['transient', 'fatal', 'hang'] as const }), required: true }),
      times: t.arg.int({ defaultValue: 1 }),
    },
    resolve: (_, args, ctx) => {
      if (!ctx.faults) throw new DomainError('INVALID_INPUT', 'Fault injection needs the worker in the same process');
      ctx.faults.arm(args.target, args.kind, Math.max(1, args.times ?? 1));
      return true;
    },
  }),
}));
