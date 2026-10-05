import type { DeploymentStatus } from '../domain/deploymentStatus.js';

export interface DeployInput {
  deploymentId: string;
  serviceId: string;
  environmentId: string;
  repo: string;
  commitSha: string;
}

export interface RollbackInput {
  deploymentId: string;
  serviceId: string;
  environmentId: string;
  /** The image of the deployment being rolled back to. */
  image: string;
}

export type LaneJob = { kind: 'deploy'; input: DeployInput } | { kind: 'rollback'; input: RollbackInput };

export interface PipelineResult {
  deploymentId: string;
  status: Extract<DeploymentStatus, 'ACTIVE' | 'FAILED' | 'CANCELLED'>;
  reason?: string;
}

export interface CancelRequest {
  reason: string;
}

export interface LaneInput {
  serviceId: string;
  environmentId: string;
  /** Carried across continue-as-new. */
  queue?: LaneJob[];
  drops?: CancelledJob[];
}

export interface CancelledJob {
  deploymentId: string;
  reason: string;
}

export const laneWorkflowId = (serviceId: string, environmentId: string): string => `lane-${serviceId}-${environmentId}`;
export const deploymentWorkflowId = (deploymentId: string): string => `deployment-${deploymentId}`;
