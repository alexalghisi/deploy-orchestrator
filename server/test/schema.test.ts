import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCatalogRepository } from '../src/db/catalog.js';
import { PgDeploymentRepository } from '../src/db/deployments.js';
import { allTransitions, InvalidTransitionError } from '../src/domain/deploymentStatus.js';
import { createTestDb, type TestDb } from './support/db.js';
import { seedProject, sha, type Fixture } from './support/fixtures.js';

let db: TestDb;
let repo: PgDeploymentRepository;
let fx: Fixture;

beforeAll(async () => {
  db = await createTestDb();
  repo = new PgDeploymentRepository(db.pool);
  fx = await seedProject(db.pool);
});

afterAll(() => db.drop());

const newDeployment = (n = 1, envId = fx.production.id) =>
  repo.create({ serviceId: fx.service.id, environmentId: envId, commitSha: sha(n), commitMessage: `commit ${n}` });

describe('database schema', () => {
  it('stores exactly the transitions the TypeScript state machine defines', async () => {
    const { rows } = await db.pool.query<{ from_status: string; to_status: string }>(
      'SELECT from_status, to_status FROM deployment_status_transitions',
    );
    const inDb = rows.map((r) => `${r.from_status}>${r.to_status}`).sort();
    const inCode = allTransitions().map(([a, b]) => `${a}>${b}`).sort();
    expect(inDb).toEqual(inCode);
  });

  it('rejects an illegal status change made with raw SQL', async () => {
    const d = await newDeployment();
    await expect(db.pool.query(`UPDATE deployments SET status = 'ACTIVE', image = 'x' WHERE id = $1`, [d.id])).rejects.toThrow(
      /cannot move from QUEUED to ACTIVE/,
    );
  });

  it('rejects inserting a deployment in any status but QUEUED', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO deployments (project_id, service_id, environment_id, status, commit_sha, image)
         VALUES ($1, $2, $3, 'ACTIVE', 'abcdef0', 'img')`,
        [fx.project.id, fx.service.id, fx.production.id],
      ),
    ).rejects.toThrow(/must start QUEUED/);
  });

  it('rejects a deployment whose environment belongs to another project', async () => {
    const other = await seedProject(db.pool);
    await expect(
      repo.create({ serviceId: fx.service.id, environmentId: other.production.id, commitSha: sha(1), commitMessage: '' }),
    ).rejects.toThrow(/foreign key/);
  });

  it('requires a failure reason exactly when FAILED', async () => {
    const d = await newDeployment();
    await expect(db.pool.query(`UPDATE deployments SET status = 'FAILED' WHERE id = $1`, [d.id])).rejects.toThrow(/check constraint/);
    const failed = await repo.transition(d.id, 'FAILED', { failureReason: 'build exploded' });
    expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'build exploded' });
    expect(failed.finishedAt).toBeInstanceOf(Date);
  });

  it('keeps commit and target immutable', async () => {
    const d = await newDeployment();
    await expect(db.pool.query(`UPDATE deployments SET commit_sha = 'fffffff' WHERE id = $1`, [d.id])).rejects.toThrow(/immutable/);
  });

  it('allows only one ACTIVE deployment per service and environment', async () => {
    const a = await newDeployment(10);
    const b = await newDeployment(11);
    for (const d of [a, b]) {
      await repo.transition(d.id, 'BUILDING');
      await repo.transition(d.id, 'DEPLOYING', { image: `img:${d.commitSha}` });
    }
    await db.pool.query(`UPDATE deployments SET status = 'REMOVED' WHERE service_id = $1 AND status = 'ACTIVE'`, [fx.service.id]);
    await db.pool.query(`UPDATE deployments SET status = 'ACTIVE' WHERE id = $1`, [a.id]);
    await expect(db.pool.query(`UPDATE deployments SET status = 'ACTIVE' WHERE id = $1`, [b.id])).rejects.toThrow(
      /deployments_one_active/,
    );
  });

  it('records every status change as an event', async () => {
    const d = await newDeployment();
    await repo.transition(d.id, 'BUILDING');
    await repo.transition(d.id, 'CANCELLED');
    const events = await repo.events([d.id]);
    expect(events.map((e) => [e.from, e.to])).toEqual([
      [null, 'QUEUED'],
      ['QUEUED', 'BUILDING'],
      ['BUILDING', 'CANCELLED'],
    ]);
  });
});

describe('PgDeploymentRepository', () => {
  it('treats a repeated transition as a no-op so activity retries are safe', async () => {
    const d = await newDeployment();
    await repo.transition(d.id, 'BUILDING');
    const again = await repo.transition(d.id, 'BUILDING');
    expect(again.status).toBe('BUILDING');
    expect(await repo.events([d.id])).toHaveLength(2);
  });

  it('validates transitions in code before touching the database', async () => {
    const d = await newDeployment();
    await expect(repo.transition(d.id, 'ACTIVE')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('promotes atomically: the previous ACTIVE deployment becomes REMOVED', async () => {
    const env = fx.staging.id;
    const first = await newDeployment(20, env);
    const second = await newDeployment(21, env);
    for (const d of [first, second]) {
      await repo.transition(d.id, 'BUILDING');
      await repo.transition(d.id, 'DEPLOYING', { image: 'img' });
    }
    await repo.promote(first.id);
    await repo.promote(second.id);
    expect((await repo.get(first.id)).status).toBe('REMOVED');
    expect((await repo.get(second.id)).status).toBe('ACTIVE');
    expect((await repo.findActive(fx.service.id, env))?.id).toBe(second.id);
    // retried promote after a lost response
    expect((await repo.promote(second.id)).status).toBe('ACTIVE');
  });

  it('pages deployments newest first with a keyset cursor', async () => {
    const catalog = new PgCatalogRepository(db.pool);
    const svc = await catalog.createService(fx.project.id, 'pager', 'github.com/acme/pager');
    for (let i = 0; i < 5; i++) {
      await repo.create({ serviceId: svc.id, environmentId: fx.production.id, commitSha: sha(100 + i), commitMessage: '' });
    }
    const page1 = await repo.listForService(svc.id, fx.production.id, 3);
    const last = page1.at(-1)!;
    const page2 = await repo.listForService(svc.id, fx.production.id, 3, { createdAt: last.createdAt, id: last.id });
    expect(page1.map((d) => d.commitSha)).toEqual([sha(104), sha(103), sha(102)]);
    expect(page2.map((d) => d.commitSha)).toEqual([sha(101), sha(100)]);
  });
});
