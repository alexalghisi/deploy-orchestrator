import { assertTransition, type DeploymentStatus } from '../domain/deploymentStatus.js';
import type { DeploymentStore, TransitionOptions } from '../domain/ports.js';
import { NotFoundError, type Deployment, type DeploymentEvent } from '../domain/types.js';
import { withTransaction, type Pool, type Queryable } from './pool.js';
import { toDeployment, toDeploymentEvent, type DeploymentEventRow, type DeploymentRow } from './rows.js';

export interface NewDeployment {
  serviceId: string;
  environmentId: string;
  commitSha: string;
  commitMessage: string;
  image?: string;
  rollbackOf?: string;
}

export class PgDeploymentRepository implements DeploymentStore {
  constructor(private readonly pool: Pool) {}

  async get(id: string): Promise<Deployment> {
    const found = await this.find(id);
    if (!found) throw new NotFoundError('Deployment', id);
    return found;
  }

  async find(id: string, db: Queryable = this.pool): Promise<Deployment | null> {
    const { rows } = await db.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [id]);
    return rows[0] ? toDeployment(rows[0]) : null;
  }

  async findMany(ids: readonly string[]): Promise<Deployment[]> {
    const { rows } = await this.pool.query<DeploymentRow>('SELECT * FROM deployments WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(toDeployment);
  }

  /** Inserts a QUEUED deployment. The service decides the project, so callers cannot mix projects. */
  async create(input: NewDeployment): Promise<Deployment> {
    const { rows } = await this.pool.query<DeploymentRow>(
      `INSERT INTO deployments (project_id, service_id, environment_id, commit_sha, commit_message, image, rollback_of)
       SELECT s.project_id, s.id, $2, $3, $4, $5, $6 FROM services s WHERE s.id = $1
       RETURNING *`,
      [input.serviceId, input.environmentId, input.commitSha, input.commitMessage, input.image ?? null, input.rollbackOf ?? null],
    );
    if (!rows[0]) throw new NotFoundError('Service', input.serviceId);
    return toDeployment(rows[0]);
  }

  async transition(id: string, to: DeploymentStatus, options: TransitionOptions = {}): Promise<Deployment> {
    const current = await this.get(id);
    if (current.status === to) return current;
    assertTransition(current.status, to);
    // compare-and-set on the status we validated against
    const { rows } = await this.pool.query<DeploymentRow>(
      `UPDATE deployments
          SET status = $3, failure_reason = COALESCE($4, failure_reason), image = COALESCE($5, image)
        WHERE id = $1 AND status = $2
        RETURNING *`,
      [id, current.status, to, options.failureReason ?? null, options.image ?? null],
    );
    if (rows[0]) return toDeployment(rows[0]);
    // someone moved it between our read and write; re-validate against the new state
    return this.transition(id, to, options);
  }

  async findActive(serviceId: string, environmentId: string): Promise<Deployment | null> {
    const { rows } = await this.pool.query<DeploymentRow>(
      `SELECT * FROM deployments WHERE service_id = $1 AND environment_id = $2 AND status = 'ACTIVE'`,
      [serviceId, environmentId],
    );
    return rows[0] ? toDeployment(rows[0]) : null;
  }

  async promote(id: string): Promise<Deployment> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw new NotFoundError('Deployment', id);
      const target = toDeployment(rows[0]);
      if (target.status === 'ACTIVE') return target;
      assertTransition(target.status, 'ACTIVE');
      await client.query(
        `UPDATE deployments SET status = 'REMOVED'
          WHERE service_id = $1 AND environment_id = $2 AND status = 'ACTIVE'`,
        [target.serviceId, target.environmentId],
      );
      const updated = await client.query<DeploymentRow>(
        `UPDATE deployments SET status = 'ACTIVE' WHERE id = $1 RETURNING *`,
        [id],
      );
      return toDeployment(updated.rows[0]!);
    });
  }

  /** Records that a user asked to cancel; the workflow does the actual work. */
  async markCancelRequested(id: string): Promise<Deployment> {
    const { rows } = await this.pool.query<DeploymentRow>(
      `UPDATE deployments SET cancel_requested_at = COALESCE(cancel_requested_at, now())
        WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!rows[0]) throw new NotFoundError('Deployment', id);
    return toDeployment(rows[0]);
  }

  /** Newest first, keyset-paginated on (created_at, id). */
  async listForService(
    serviceId: string,
    environmentId: string,
    limit: number,
    before?: { createdAt: Date; id: string },
  ): Promise<Deployment[]> {
    const { rows } = await this.pool.query<DeploymentRow>(
      `SELECT * FROM deployments
        WHERE service_id = $1 AND environment_id = $2
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [serviceId, environmentId, limit, before?.createdAt ?? null, before?.id ?? null],
    );
    return rows.map(toDeployment);
  }

  /** The newest deployment per service in one environment, for the canvas. */
  async latestForServices(serviceIds: readonly string[], environmentId: string): Promise<Deployment[]> {
    const { rows } = await this.pool.query<DeploymentRow>(
      `SELECT DISTINCT ON (service_id) * FROM deployments
        WHERE service_id = ANY($1::uuid[]) AND environment_id = $2
        ORDER BY service_id, created_at DESC, id DESC`,
      [serviceIds, environmentId],
    );
    return rows.map(toDeployment);
  }

  async events(deploymentIds: readonly string[]): Promise<DeploymentEvent[]> {
    const { rows } = await this.pool.query<DeploymentEventRow>(
      `SELECT id::text, deployment_id, from_status, to_status, at FROM deployment_events
        WHERE deployment_id = ANY($1::uuid[]) ORDER BY id`,
      [deploymentIds],
    );
    return rows.map(toDeploymentEvent);
  }
}
