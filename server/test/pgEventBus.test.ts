import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDeploymentRepository } from '../src/db/deployments.js';
import { withTransaction } from '../src/db/pool.js';
import type { DeploymentChanged } from '../src/events/bus.js';
import { PgEventBus } from '../src/events/pgEventBus.js';
import { createTestDb, type TestDb } from './support/db.js';
import { seedProject, sha, type Fixture } from './support/fixtures.js';

let db: TestDb;
let bus: PgEventBus;
let fx: Fixture;

beforeAll(async () => {
  db = await createTestDb();
  bus = new PgEventBus(db.pool, db.url);
  await bus.start();
  fx = await seedProject(db.pool);
});

afterAll(async () => {
  await bus.stop();
  await db.drop();
});

async function collectFor(id: string, count: number, events: AsyncIterator<DeploymentChanged>): Promise<string[]> {
  const out: string[] = [];
  while (out.length < count) {
    const next = await events.next();
    if (next.done) break;
    if (next.value.id === id) out.push(next.value.status);
  }
  return out;
}

describe('PgEventBus', () => {
  it('delivers status changes published by the database trigger', async () => {
    const events = bus.subscribe('deploymentChanged');
    const repo = new PgDeploymentRepository(db.pool);
    const d = await repo.create({ serviceId: fx.service.id, environmentId: fx.production.id, commitSha: sha(1), commitMessage: '' });
    await repo.transition(d.id, 'BUILDING');
    expect(await collectFor(d.id, 2, events)).toEqual(['QUEUED', 'BUILDING']);
    await events.return();
  });

  it('does not deliver changes from a rolled back transaction', async () => {
    const events = bus.subscribe('deploymentChanged');
    const repo = new PgDeploymentRepository(db.pool);
    const d = await repo.create({ serviceId: fx.service.id, environmentId: fx.production.id, commitSha: sha(2), commitMessage: '' });
    await withTransaction(db.pool, async (client) => {
      await client.query(`UPDATE deployments SET status = 'BUILDING' WHERE id = $1`, [d.id]);
      throw new Error('abort');
    }).catch(() => {});
    await repo.transition(d.id, 'CANCELLED');
    expect(await collectFor(d.id, 2, events)).toEqual(['QUEUED', 'CANCELLED']);
    await events.return();
  });

  it('round-trips published log announcements', async () => {
    const events = bus.subscribe('logsAppended');
    await bus.publish('logsAppended', { deploymentId: 'abc', seq: '42' });
    expect((await events.next()).value).toEqual({ deploymentId: 'abc', seq: '42' });
    await events.return();
  });
});
