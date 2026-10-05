import type { DeploymentStatus } from './deploymentStatus.js';
import type { Deployment } from './types.js';

export interface TransitionOptions {
  failureReason?: string;
  image?: string;
}

/**
 * Persistence for the deployment lifecycle. Workflow activities only talk to
 * this interface, so the workflow tests run against an in-memory version with
 * the same rules.
 */
export interface DeploymentStore {
  get(id: string): Promise<Deployment>;
  /**
   * Moves a deployment to `to`. Calling it again with the status it already
   * has is a no-op, because activities can be retried after a successful
   * commit whose response got lost.
   */
  transition(id: string, to: DeploymentStatus, options?: TransitionOptions): Promise<Deployment>;
  /** The deployment currently serving traffic for the same service and environment. */
  findActive(serviceId: string, environmentId: string): Promise<Deployment | null>;
  /** Atomically retires whatever is ACTIVE for the service and environment and activates `id`. */
  promote(id: string): Promise<Deployment>;
}
