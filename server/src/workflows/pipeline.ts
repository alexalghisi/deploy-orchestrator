import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { Activities } from './activities.js';
import { cancelSignal } from './signals.js';
import type { PipelineResult } from './types.js';

/**
 * Build steps call flaky external systems and are worth a few retries.
 * A non-retryable failure (compile error) stops immediately.
 */
const build = proxyActivities<Activities>({
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '20 seconds',
  // compensation must not run while a cancelled build is still writing
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 3 },
});

/**
 * Provisioning must finish cancelling before compensation releases the
 * instance, or a late provision could recreate it after the release.
 */
const provision = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '10 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumAttempts: 3 },
});

/** Bookkeeping and routing: idempotent, cheap, and they must eventually succeed. */
const control = proxyActivities<Activities>({
  startToCloseTimeout: '15 seconds',
  retry: { initialInterval: '200 milliseconds', backoffCoefficient: 2, maximumInterval: '10 seconds' },
});

export interface PipelinePlan {
  deploymentId: string;
  serviceId: string;
  environmentId: string;
  /** Produces the image to run. Rollbacks skip it and reuse an existing one. */
  build?: () => Promise<string>;
  image?: string;
}

/**
 * The part of a deploy shared with rollbacks: get an image, run it, check it,
 * move traffic, retire the old one. Anything up to the health check can be
 * cancelled and is compensated; once traffic moves there is no going back.
 */
export async function runPipeline(plan: PipelinePlan): Promise<PipelineResult> {
  const { deploymentId } = plan;
  const cancellable = new CancellationScope();
  let cancelReason: string | null = null;
  let pastPointOfNoReturn = false;
  let provisioningStarted = false;

  setHandler(cancelSignal, ({ reason }) => {
    if (pastPointOfNoReturn || cancelReason) return;
    cancelReason = reason;
    cancellable.cancel();
  });

  let instanceId: string;
  try {
    instanceId = await cancellable.run(async () => {
      let image = plan.image;
      if (plan.build) {
        await control.recordStatus({ deploymentId, status: 'BUILDING' });
        image = await plan.build();
      }
      if (!image) throw ApplicationFailure.nonRetryable('No image to deploy');
      await control.recordStatus({ deploymentId, status: 'DEPLOYING', image });
      provisioningStarted = true;
      const instance = await provision.provisionInstance({ deploymentId, image });
      await provision.healthCheck({ deploymentId, instanceId: instance.instanceId });
      return instance.instanceId;
    });
  } catch (err) {
    return CancellationScope.nonCancellable(async () => {
      if (provisioningStarted) await control.releaseInstance({ deploymentId });
      if (cancelReason !== null || isCancellation(err)) {
        const reason = cancelReason ?? 'Cancelled';
        await control.recordStatus({ deploymentId, status: 'CANCELLED', message: reason });
        return { deploymentId, status: 'CANCELLED', reason };
      }
      const reason = describeFailure(err);
      await control.recordStatus({ deploymentId, status: 'FAILED', failureReason: reason, message: `Deployment failed: ${reason}` });
      return { deploymentId, status: 'FAILED', reason };
    });
  }

  pastPointOfNoReturn = true;
  return CancellationScope.nonCancellable(async () => {
    const previous = await control.findActive({ serviceId: plan.serviceId, environmentId: plan.environmentId });
    await control.switchTraffic({ deploymentId, serviceId: plan.serviceId, environmentId: plan.environmentId, instanceId });
    if (previous && previous.deploymentId !== deploymentId) {
      await control.teardownPrevious({ deploymentId, previousDeploymentId: previous.deploymentId });
    }
    return { deploymentId, status: 'ACTIVE' };
  });
}

export async function buildAndPush(input: { deploymentId: string; repo: string; commitSha: string }): Promise<string> {
  const { image } = await build.buildImage(input);
  await build.pushImage({ deploymentId: input.deploymentId, image });
  return image;
}

function describeFailure(err: unknown): string {
  const root = err instanceof ActivityFailure && err.cause ? err.cause : err;
  return root instanceof Error ? root.message : String(root);
}
