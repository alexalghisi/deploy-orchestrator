/**
 * End-to-end orchestration overhead against a real Temporal dev server,
 * Postgres and ClickHouse, with the fake services set to zero latency: what
 * is left is the cost of the workflow, its activities, the database writes
 * and the event fan-out to a GraphQL subscriber.
 *
 *   temporal server start-dev --headless &
 *   npm run bench:deploys
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { createApi } from '../src/api/server.js';
import { DeploymentCommands } from '../src/app/deploymentCommands.js';
import { TemporalScheduler } from '../src/app/scheduler.js';
import { config } from '../src/config.js';
import { PgCatalogRepository } from '../src/db/catalog.js';
import { PgDeploymentRepository } from '../src/db/deployments.js';
import { PgEventBus } from '../src/events/pgEventBus.js';
import { FakeBuilder } from '../src/fakes/builder.js';
import { FaultInjector } from '../src/fakes/faults.js';
import { FakeInstanceRunner, FakeRouter } from '../src/fakes/runner.js';
import { Clock } from '../src/fakes/timing.js';
import { BufferedLogSink } from '../src/logs/bufferedLogSink.js';
import { ClickHouseLogStore } from '../src/logs/clickhouseLogStore.js';
import { createActivities } from '../src/workflows/activities.js';
import { createWorker } from '../src/workflows/worker.js';
import { createTestDb } from '../test/support/db.js';
import { gql, subscribe } from '../test/support/graphql.js';
import { summary } from './stats.js';

const SEQUENTIAL = Number(process.env.SEQUENTIAL ?? 50);
const PARALLEL = Number(process.env.PARALLEL ?? 25);
const LOG_LINES = 2_000;

Runtime.install({ logger: new DefaultLogger('ERROR') });
const db = await createTestDb();
const bus = new PgEventBus(db.pool, db.url);
await bus.start();
const logStore = await ClickHouseLogStore.connect(config.clickhouseUrl, `deployorch_bench_${randomUUID().slice(0, 8)}`);
const deployments = new PgDeploymentRepository(db.pool);
const catalog = new PgCatalogRepository(db.pool);
const taskQueue = `bench-${randomUUID().slice(0, 8)}`;
const clock = new Clock(0);
const faults = new FaultInjector();
const sink = new BufferedLogSink(logStore, bus);

const worker = await createWorker({
  address: config.temporalAddress,
  namespace: config.temporalNamespace,
  taskQueue,
  activities: createActivities({
    store: deployments,
    logs: sink,
    builder: new FakeBuilder(clock, faults),
    runner: new FakeInstanceRunner(clock, faults),
    router: new FakeRouter(clock),
    clock,
  }),
});
const workerDone = worker.run();
const scheduler = await TemporalScheduler.connect(config.temporalAddress, config.temporalNamespace, taskQueue);
const yoga = createApi({ catalog, deployments, commands: new DeploymentCommands(deployments, catalog, scheduler), logs: logStore, bus });

const project = await catalog.createProject('bench', ['production']);
const [env] = await catalog.environmentsByProject([project.id]);
const services = [];
for (let i = 0; i < PARALLEL; i++) services.push(await catalog.createService(project.id, `svc-${i}`, `github.com/bench/svc-${i}`));

// a subscriber, exactly as the dashboard subscribes
const seen = new Map<string, number>(); // `${id}:${status}` -> received at (epoch ms)
const waiters = new Map<string, () => void>();
const abort = new AbortController();
void (async () => {
  const stream = subscribe<{ deploymentUpdated: { id: string; status: string } }>(
    yoga,
    `subscription ($p: ID!, $e: ID!) { deploymentUpdated(projectId: $p, environmentId: $e) { id status } }`,
    { p: project.id, e: env!.id },
    abort.signal,
  );
  for await (const msg of stream) {
    const d = msg.data?.deploymentUpdated;
    if (!d) continue;
    const key = `${d.id}:${d.status}`;
    seen.set(key, Date.now());
    waiters.get(key)?.();
  }
})().catch(() => {});
await new Promise((r) => setTimeout(r, 200));

const untilSeen = (id: string, status: string) =>
  new Promise<void>((resolve) => {
    if (seen.has(`${id}:${status}`)) return resolve();
    waiters.set(`${id}:${status}`, resolve);
  });

async function deploy(serviceId: string): Promise<string> {
  const r = await gql<{ deployService: { id: string } }>(
    yoga,
    `mutation ($s: ID!, $e: ID!) { deployService(serviceId: $s, environmentId: $e) { id } }`,
    { s: serviceId, e: env!.id },
  );
  if (!r.data) throw new Error(JSON.stringify(r.errors));
  return r.data.deployService.id;
}

try {
  // warm up: bundle, connections, first lane
  await untilSeen(await deploy(services[0]!.id), 'ACTIVE');

  const endToEnd: number[] = [];
  const ids: string[] = [];
  for (let i = 0; i < SEQUENTIAL; i++) {
    const t = performance.now();
    const id = await deploy(services[i % services.length]!.id);
    await untilSeen(id, 'ACTIVE');
    endToEnd.push(performance.now() - t);
    ids.push(id);
  }
  console.log(summary('deployService -> ACTIVE seen by subscriber', endToEnd));

  // commit time comes from the trigger (clock_timestamp), receipt time from the subscriber
  const events = await deployments.events(ids);
  const fanout = events.map((e) => (seen.get(`${e.deploymentId}:${e.to}`) ?? Number.NaN) - e.at.getTime()).filter(Number.isFinite);
  console.log(summary('status commit -> subscriber (SSE)', fanout));

  const t = performance.now();
  const batch = await Promise.all(services.map((s) => deploy(s.id)));
  await Promise.all(batch.map((id) => untilSeen(id, 'ACTIVE')));
  console.log(`${PARALLEL} services deployed concurrently: all ACTIVE after ${(performance.now() - t).toFixed(0)} ms`);

  // log lines: write -> visible to a log subscriber
  const target = ids[0]!;
  const received: number[] = [];
  const logAbort = new AbortController();
  const logStream = subscribe<{ deploymentLogs: { lines: { message: string }[] } }>(
    yoga,
    `subscription ($id: ID!, $after: String) { deploymentLogs(deploymentId: $id, after: $after) { lines { message } } }`,
    // start after "now" on the sequence's own scale, skipping the deploy's history
    { id: target, after: ((BigInt(Date.now()) * 1000n) << 10n).toString() },
    logAbort.signal,
  );
  const done = (async () => {
    for await (const msg of logStream) {
      for (const line of msg.data?.deploymentLogs.lines ?? []) {
        const sentAt = Number(line.message.split(' ')[1]);
        received.push(Date.now() - sentAt);
      }
      if (received.length >= LOG_LINES) return;
    }
  })();
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < LOG_LINES; i++) {
    sink.write(target, 'deploy', 'info', `bench ${Date.now()}`);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 5));
  }
  await sink.flush();
  await done;
  logAbort.abort();
  console.log(summary('log line written -> log subscriber (SSE)', received));
} finally {
  abort.abort();
  worker.shutdown();
  await workerDone;
  await scheduler.close();
  await bus.stop();
  await logStore.dropDatabase();
  await logStore.close();
  await db.drop();
}
