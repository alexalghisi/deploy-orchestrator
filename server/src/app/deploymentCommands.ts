import type { PgCatalogRepository } from '../db/catalog.js';
import type { PgDeploymentRepository } from '../db/deployments.js';
import { isInFlight } from '../domain/deploymentStatus.js';
import type { Deployment } from '../domain/types.js';
import { headCommit } from './commits.js';
import { DomainError } from './errors.js';
import type { DeploymentScheduler } from './scheduler.js';

export interface DeployRequest {
  serviceId: string;
  environmentId: string;
  commitSha?: string | null;
  commitMessage?: string | null;
}

/**
 * The write side of the API. Each command writes the row first and then
 * hands the work to the scheduler; if scheduling fails the row is failed
 * rather than left QUEUED forever.
 */
export class DeploymentCommands {
  constructor(
    private readonly deployments: PgDeploymentRepository,
    private readonly catalog: PgCatalogRepository,
    private readonly scheduler: DeploymentScheduler,
  ) {}

  async deploy(request: DeployRequest): Promise<Deployment> {
    const [service] = await this.catalog.servicesById([request.serviceId]);
    if (!service) throw new DomainError('NOT_FOUND', `Service ${request.serviceId} not found`);
    const [environment] = await this.catalog.environmentsById([request.environmentId]);
    if (!environment || environment.projectId !== service.projectId) {
      throw new DomainError('INVALID_INPUT', 'Environment does not belong to the service’s project');
    }
    if (request.commitSha && !/^[0-9a-f]{7,40}$/.test(request.commitSha)) {
      throw new DomainError('INVALID_INPUT', 'commitSha must be 7 to 40 lowercase hex characters');
    }
    const head = headCommit();
    const deployment = await this.deployments.create({
      serviceId: service.id,
      environmentId: environment.id,
      commitSha: request.commitSha ?? head.sha,
      commitMessage: request.commitMessage ?? (request.commitSha ? '' : head.message),
    });
    return this.schedule(deployment, () =>
      this.scheduler.enqueue({
        kind: 'deploy',
        input: {
          deploymentId: deployment.id,
          serviceId: service.id,
          environmentId: environment.id,
          repo: service.repo,
          commitSha: deployment.commitSha,
        },
      }),
    );
  }

  async cancel(deploymentId: string): Promise<Deployment> {
    const deployment = await this.find(deploymentId);
    if (!isInFlight(deployment.status)) {
      throw new DomainError('NOT_CANCELLABLE', `A ${deployment.status} deployment cannot be cancelled`);
    }
    const marked = await this.deployments.markCancelRequested(deploymentId);
    await this.scheduler.cancel(
      { serviceId: deployment.serviceId, environmentId: deployment.environmentId, deploymentId },
      'Cancelled by user',
    );
    return marked;
  }

  /** Rolls back by deploying the image of a deployment that was live before. */
  async rollback(targetId: string): Promise<Deployment> {
    const target = await this.find(targetId);
    if (target.status !== 'REMOVED' || !target.image) {
      throw new DomainError('NOT_ROLLBACKABLE', 'Only a deployment that was previously live can be rolled back to');
    }
    const deployment = await this.deployments.create({
      serviceId: target.serviceId,
      environmentId: target.environmentId,
      commitSha: target.commitSha,
      commitMessage: `Rollback to ${target.commitSha.slice(0, 7)}`,
      image: target.image,
      rollbackOf: target.id,
    });
    const image = target.image;
    return this.schedule(deployment, () =>
      this.scheduler.enqueue({
        kind: 'rollback',
        input: { deploymentId: deployment.id, serviceId: target.serviceId, environmentId: target.environmentId, image },
      }),
    );
  }

  private async find(id: string): Promise<Deployment> {
    const deployment = await this.deployments.find(id);
    if (!deployment) throw new DomainError('NOT_FOUND', `Deployment ${id} not found`);
    return deployment;
  }

  private async schedule(deployment: Deployment, enqueue: () => Promise<void>): Promise<Deployment> {
    try {
      await enqueue();
      return deployment;
    } catch (err) {
      await this.deployments.transition(deployment.id, 'FAILED', { failureReason: 'Could not reach the orchestrator' });
      const detail = err instanceof Error ? err.message : String(err);
      throw new DomainError('SCHEDULING_FAILED', `Deployment could not be scheduled: ${detail}`);
    }
  }
}
