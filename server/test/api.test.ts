import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createApi } from '../src/api/server.js';
import { printedSchema, SCHEMA_FILE } from '../src/api/printSchema.js';
import { DeploymentCommands } from '../src/app/deploymentCommands.js';
import type { DeploymentScheduler } from '../src/app/scheduler.js';
import { PgCatalogRepository } from '../src/db/catalog.js';
import { PgDeploymentRepository } from '../src/db/deployments.js';
import { PgEventBus } from '../src/events/pgEventBus.js';
import { FaultInjector } from '../src/fakes/faults.js';
import { BufferedLogSink } from '../src/logs/bufferedLogSink.js';
import { MemoryLogStore } from '../src/logs/memoryLogStore.js';
import type { LaneJob } from '../src/workflows/types.js';
import { createTestDb, type TestDb } from './support/db.js';
import { seedProject, sha, type Fixture } from './support/fixtures.js';
import { gql, nextData, subscribe } from './support/graphql.js';

class RecordingScheduler implements DeploymentScheduler {
  jobs: LaneJob[] = [];
  cancels: string[] = [];
  failWith: Error | null = null;
  async enqueue(job: LaneJob) {
    if (this.failWith) throw this.failWith;
    this.jobs.push(job);
  }
  async cancel(target: { deploymentId: string }) {
    this.cancels.push(target.deploymentId);
  }
}

let db: TestDb;
let bus: PgEventBus;
let fx: Fixture;
let repo: PgDeploymentRepository;
let catalog: PgCatalogRepository;
let scheduler: RecordingScheduler;
let logs: MemoryLogStore;
let yoga: ReturnType<typeof createApi>;
let queryCount = 0;

beforeAll(async () => {
  db = await createTestDb();
  const query = db.pool.query.bind(db.pool);
  db.pool.query = ((...args: Parameters<typeof query>) => {
    queryCount++;
    return query(...args);
  }) as typeof db.pool.query;
  bus = new PgEventBus(db.pool, db.url);
  await bus.start();
  repo = new PgDeploymentRepository(db.pool);
  catalog = new PgCatalogRepository(db.pool);
  scheduler = new RecordingScheduler();
  logs = new MemoryLogStore();
  yoga = createApi({
    catalog,
    deployments: repo,
    commands: new DeploymentCommands(repo, catalog, scheduler),
    logs,
    bus,
    faults: new FaultInjector(),
  });
  fx = await seedProject(db.pool);
});

afterAll(async () => {
  await bus.stop();
  await db.drop();
});

beforeEach(() => {
  scheduler.jobs = [];
  scheduler.cancels = [];
  scheduler.failWith = null;
});

const DEPLOY = /* GraphQL */ `
  mutation ($serviceId: ID!, $environmentId: ID!, $commitSha: String) {
    deployService(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) {
      id status commitSha canCancel canRollback isRollback
    }
  }
`;

interface DeployData {
  deployService: { id: string; status: string; commitSha: string; canCancel: boolean };
}

async function deploy(envId = fx.production.id, commitSha: string | null = null) {
  const result = await gql<DeployData>(yoga, DEPLOY, { serviceId: fx.service.id, environmentId: envId, commitSha });
  if (!result.data) throw new Error(JSON.stringify(result.errors));
  return result.data.deployService;
}

/** Drives a deployment to ACTIVE the way the workflow would. */
async function makeActive(id: string) {
  await repo.transition(id, 'BUILDING');
  await repo.transition(id, 'DEPLOYING', { image: `img-${id.slice(0, 4)}` });
  await repo.promote(id);
}

describe('schema', () => {
  it('matches the committed schema.graphql the dashboard is checked against', async () => {
    expect(await readFile(SCHEMA_FILE, 'utf8')).toBe(printedSchema());
  });
});

describe('queries', () => {
  it('returns projects with services, environments and their latest deployment', async () => {
    const d = await deploy(fx.production.id, sha(1));
    const result = await gql<{
      project: { name: string; environments: { name: string }[]; services: { name: string; latestDeployment: { id: string } | null }[] };
    }>(
      yoga,
      `query ($id: ID!, $env: ID!) { project(id: $id) { name environments { name } services { name latestDeployment(environmentId: $env) { id } } } }`,
      { id: fx.project.id, env: fx.production.id },
    );
    expect(result.data?.project).toEqual({
      name: fx.project.name,
      environments: [{ name: 'production' }, { name: 'staging' }],
      services: [{ name: 'api', latestDeployment: { id: d.id } }],
    });
  });

  it('loads the canvas in a constant number of queries, however many services there are', async () => {
    const big = await seedProject(db.pool, 'many-services');
    await repo.create({ serviceId: big.service.id, environmentId: big.production.id, commitSha: sha(1), commitMessage: '' });
    const canvas = `query ($id: ID!, $env: ID!) { project(id: $id) { services { name latestDeployment(environmentId: $env) { status service { name } environment { name } } } } }`;
    const count = async () => {
      queryCount = 0;
      const r = await gql(yoga, canvas, { id: big.project.id, env: big.production.id });
      expect(r.errors).toBeUndefined();
      return queryCount;
    };
    const withOne = await count();
    for (let i = 0; i < 12; i++) {
      const s = await catalog.createService(big.project.id, `svc-${i}`, `github.com/acme/svc-${i}`);
      await repo.create({ serviceId: s.id, environmentId: big.production.id, commitSha: sha(i), commitMessage: '' });
    }
    expect(await count()).toBe(withOne);
  });

  it('pages a service’s deployments newest first', async () => {
    const env = fx.staging.id;
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await deploy(env, sha(200 + i))).id);
    const page = `query ($s: ID!, $e: ID!, $after: String) { service(id: $s) { deployments(environmentId: $e, first: 2, after: $after) { nodes { id } endCursor hasNextPage } } }`;
    type Page = { service: { deployments: { nodes: { id: string }[]; endCursor: string | null; hasNextPage: boolean } } };
    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const r: { data?: Page } = await gql<Page>(yoga, page, { s: fx.service.id, e: env, after });
      const conn = r.data!.service.deployments;
      seen.push(...conn.nodes.map((n) => n.id));
      if (!conn.hasNextPage) break;
      after = conn.endCursor;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  it('pages logs by cursor', async () => {
    const d = await deploy();
    const sink = new BufferedLogSink(logs, bus);
    for (let i = 0; i < 7; i++) sink.write(d.id, 'build', 'info', `line ${i}`);
    await sink.flush();
    type Logs = { deployment: { logs: { lines: { message: string }[]; endCursor: string; hasMore: boolean } } };
    const q = `query ($id: ID!, $after: String) { deployment(id: $id) { logs(first: 5, after: $after) { lines { message } endCursor hasMore } } }`;
    const first = await gql<Logs>(yoga, q, { id: d.id });
    expect(first.data?.deployment.logs.lines).toHaveLength(5);
    expect(first.data?.deployment.logs.hasMore).toBe(true);
    const second = await gql<Logs>(yoga, q, { id: d.id, after: first.data?.deployment.logs.endCursor });
    expect(second.data?.deployment.logs.lines.map((l) => l.message)).toEqual(['line 5', 'line 6']);
    expect(second.data?.deployment.logs.hasMore).toBe(false);
  });

  it('rejects a malformed cursor with INVALID_INPUT', async () => {
    const r = await gql(yoga, `query ($s: ID!, $e: ID!) { service(id: $s) { deployments(environmentId: $e, after: "nope") { nodes { id } } } }`, {
      s: fx.service.id,
      e: fx.production.id,
    });
    expect(r.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });
});

describe('deployService', () => {
  it('creates a QUEUED deployment and hands it to the orchestrator', async () => {
    const d = await deploy(fx.production.id, 'abc1234');
    expect(d).toMatchObject({ status: 'QUEUED', commitSha: 'abc1234', canCancel: true });
    expect(scheduler.jobs).toEqual([
      {
        kind: 'deploy',
        input: { deploymentId: d.id, serviceId: fx.service.id, environmentId: fx.production.id, repo: 'github.com/acme/api', commitSha: 'abc1234' },
      },
    ]);
  });

  it('rejects an environment from another project', async () => {
    const other = await seedProject(db.pool);
    const r = await gql(yoga, DEPLOY, { serviceId: fx.service.id, environmentId: other.production.id });
    expect(r.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
    expect(scheduler.jobs).toEqual([]);
  });

  it('fails the deployment instead of leaving it QUEUED when the orchestrator is unreachable', async () => {
    scheduler.failWith = new Error('connect ECONNREFUSED 127.0.0.1:7233');
    const r = await gql(yoga, DEPLOY, { serviceId: fx.service.id, environmentId: fx.production.id });
    expect(r.errors?.[0]?.extensions?.code).toBe('SCHEDULING_FAILED');
    const [latest] = await repo.listForService(fx.service.id, fx.production.id, 1);
    expect(latest).toMatchObject({ status: 'FAILED', failureReason: 'Could not reach the orchestrator' });
  });
});

describe('cancelDeployment', () => {
  const CANCEL = `mutation ($id: ID!) { cancelDeployment(id: $id) { id status cancelRequested canCancel } }`;

  it('marks an in-flight deployment and signals the orchestrator', async () => {
    const d = await deploy();
    const r = await gql<{ cancelDeployment: object }>(yoga, CANCEL, { id: d.id });
    expect(r.data?.cancelDeployment).toEqual({ id: d.id, status: 'QUEUED', cancelRequested: true, canCancel: false });
    expect(scheduler.cancels).toEqual([d.id]);
  });

  it('refuses to cancel a finished deployment', async () => {
    const d = await deploy();
    await repo.transition(d.id, 'FAILED', { failureReason: 'x' });
    const r = await gql(yoga, CANCEL, { id: d.id });
    expect(r.errors?.[0]).toMatchObject({ message: 'A FAILED deployment cannot be cancelled', extensions: { code: 'NOT_CANCELLABLE' } });
    expect(scheduler.cancels).toEqual([]);
  });

  it('returns NOT_FOUND for an unknown id', async () => {
    const r = await gql(yoga, CANCEL, { id: '00000000-0000-0000-0000-000000000000' });
    expect(r.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });
});

describe('rollback', () => {
  const ROLLBACK = `mutation ($to: ID!) { rollback(to: $to) { id status isRollback image commitSha rollbackOf { id } } }`;

  it('creates a rollback deployment that reuses the earlier image', async () => {
    const v1 = await deploy(fx.production.id, sha(301));
    await makeActive(v1.id);
    const v2 = await deploy(fx.production.id, sha(302));
    await makeActive(v2.id);

    const r = await gql<{ rollback: { id: string; image: string } }>(yoga, ROLLBACK, { to: v1.id });
    const image = (await repo.get(v1.id)).image;
    expect(r.data?.rollback).toMatchObject({ status: 'QUEUED', isRollback: true, image, commitSha: sha(301), rollbackOf: { id: v1.id } });
    expect(scheduler.jobs.at(-1)).toEqual({
      kind: 'rollback',
      input: { deploymentId: r.data?.rollback.id, serviceId: fx.service.id, environmentId: fx.production.id, image },
    });
  });

  it('only rolls back to something that was live before', async () => {
    const d = await deploy();
    const r = await gql(yoga, ROLLBACK, { to: d.id });
    expect(r.errors?.[0]?.extensions?.code).toBe('NOT_ROLLBACKABLE');
  });
});

describe('subscriptions', () => {
  it('streams status changes for the project environment over SSE', async () => {
    const abort = new AbortController();
    const stream = subscribe<{ deploymentUpdated: { id: string; status: string } }>(
      yoga,
      `subscription ($p: ID!, $e: ID!) { deploymentUpdated(projectId: $p, environmentId: $e) { id status } }`,
      { p: fx.project.id, e: fx.production.id },
      abort.signal,
    );
    const firstEvent = nextData(stream);
    await new Promise((r) => setTimeout(r, 100)); // let the subscription attach
    const d = await deploy();
    await deploy(fx.staging.id); // other environment: filtered out
    await repo.transition(d.id, 'BUILDING');

    const seen = [await firstEvent, await nextData(stream)].map((e) => e.deploymentUpdated);
    expect(seen).toEqual([
      { id: d.id, status: 'QUEUED' },
      { id: d.id, status: 'BUILDING' },
    ]);
    abort.abort();
  });

  it('streams log history, then new lines', async () => {
    const d = await deploy();
    const sink = new BufferedLogSink(logs, bus);
    sink.write(d.id, 'build', 'info', 'before subscribe');
    await sink.flush();

    const abort = new AbortController();
    const stream = subscribe<{ deploymentLogs: { lines: { message: string }[]; cursor: string } }>(
      yoga,
      `subscription ($id: ID!) { deploymentLogs(deploymentId: $id) { cursor lines { message } } }`,
      { id: d.id },
      abort.signal,
    );
    const history = await nextData(stream);
    expect(history.deploymentLogs.lines.map((l) => l.message)).toEqual(['before subscribe']);

    sink.write(d.id, 'deploy', 'info', 'after subscribe');
    await sink.flush();
    const live = await nextData(stream);
    expect(live.deploymentLogs.lines.map((l) => l.message)).toEqual(['after subscribe']);
    abort.abort();
  });
});

describe('errors', () => {
  it('masks unexpected errors', async () => {
    const r = await gql(yoga, `query { deployment(id: "not-a-uuid") { id } }`);
    expect(r.errors?.[0]).toMatchObject({ message: 'Unexpected error.', extensions: { code: 'INTERNAL' } });
  });
});
