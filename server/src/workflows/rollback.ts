import { runPipeline } from './pipeline.js';
import type { PipelineResult, RollbackInput } from './types.js';

/**
 * A rollback is a new deployment of an image that already exists: no build,
 * but the same provisioning, health check and traffic switch as a deploy, so
 * a broken old image cannot replace a healthy current one.
 */
export async function rollbackWorkflow(input: RollbackInput): Promise<PipelineResult> {
  return runPipeline({
    deploymentId: input.deploymentId,
    serviceId: input.serviceId,
    environmentId: input.environmentId,
    image: input.image,
  });
}
