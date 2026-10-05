import { randomUUID } from 'node:crypto';
import { assertTransition, type DeploymentStatus } from '../../src/domain/deploymentStatus.js';
import type { DeploymentStore, TransitionOptions } from '../../src/domain/ports.js';
import { NotFoundError, type Deployment } from '../../src/domain/types.js';

/** In-memory DeploymentStore with the same rules as the Postgres one, for workflow tests. */
export class MemoryDeploymentStore implements DeploymentStore {
  private readonly rows = new Map<string, Deployment>();
  readonly history = new Map<string, DeploymentStatus[]>();

  create(input: { serviceId: string; environmentId: string; commitSha?: string; image?: string; rollbackOf?: string }): Deployment {
    const now = new Date();
    const d: Deployment = {
      id: randomUUID(),
      projectId: 'p',
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      status: 'QUEUED',
      commitSha: input.commitSha ?? 'abcdef0',
      commitMessage: '',
      image: input.image ?? null,
      rollbackOf: input.rollbackOf ?? null,
      failureReason: null,
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.rows.set(d.id, d);
    this.history.set(d.id, ['QUEUED']);
    return d;
  }

  async get(id: string): Promise<Deployment> {
    const d = this.rows.get(id);
    if (!d) throw new NotFoundError('Deployment', id);
    return { ...d };
  }

  async transition(id: string, to: DeploymentStatus, options: TransitionOptions = {}): Promise<Deployment> {
    const d = await this.get(id);
    if (d.status === to) return d;
    assertTransition(d.status, to);
    if (to === 'ACTIVE') {
      const other = await this.findActive(d.serviceId, d.environmentId);
      if (other) throw new Error('unique violation: deployments_one_active');
    }
    const next: Deployment = {
      ...d,
      status: to,
      image: options.image ?? d.image,
      failureReason: options.failureReason ?? d.failureReason,
      updatedAt: new Date(),
    };
    this.rows.set(id, next);
    this.history.get(id)?.push(to);
    return { ...next };
  }

  async findActive(serviceId: string, environmentId: string): Promise<Deployment | null> {
    const found = [...this.rows.values()].find(
      (d) => d.serviceId === serviceId && d.environmentId === environmentId && d.status === 'ACTIVE',
    );
    return found ? { ...found } : null;
  }

  async promote(id: string): Promise<Deployment> {
    const d = await this.get(id);
    if (d.status === 'ACTIVE') return d;
    const previous = await this.findActive(d.serviceId, d.environmentId);
    if (previous) await this.transition(previous.id, 'REMOVED');
    return this.transition(id, 'ACTIVE');
  }

  statusOf(id: string): DeploymentStatus | undefined {
    return this.rows.get(id)?.status;
  }
}
