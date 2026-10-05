import { buildAndPush, runPipeline } from './pipeline.js';
import type { DeployInput, PipelineResult } from './types.js';

export async function deployWorkflow(input: DeployInput): Promise<PipelineResult> {
  return runPipeline({
    deploymentId: input.deploymentId,
    serviceId: input.serviceId,
    environmentId: input.environmentId,
    build: () => buildAndPush(input),
  });
}
