import type { Server } from 'node:http';
import type { Worker } from '@temporalio/worker';
import { listen } from './api/server.js';
import { DeploymentCommands } from './app/deploymentCommands.js';
import { TemporalScheduler } from './app/scheduler.js';
import { config } from './config.js';
import { PgCatalogRepository } from './db/catalog.js';
import { PgDeploymentRepository } from './db/deployments.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { seed } from './db/seed.js';
import { PgEventBus } from './events/pgEventBus.js';
import { FakeBuilder } from './fakes/builder.js';
import { FaultInjector } from './fakes/faults.js';
import { FakeInstanceRunner, FakeRouter } from './fakes/runner.js';
import { Clock } from './fakes/timing.js';
import { BufferedLogSink } from './logs/bufferedLogSink.js';
import { ClickHouseLogStore } from './logs/clickhouseLogStore.js';
import { createActivities } from './workflows/activities.js';
import { createWorker } from './workflows/worker.js';

type Role = 'api' | 'worker' | 'all';

function role(): Role {
  const value = process.env.ROLE ?? 'all';
  if (value === 'api' || value === 'worker' || value === 'all') return value;
  throw new Error(`ROLE must be api, worker or all, got "${value}"`);
}

/**
 * Composition root. ROLE=api and ROLE=worker run the halves separately; the
 * default runs both in one process, which the demo needs for fault injection
 * because the fake services live in the worker.
 */
async function main(): Promise<void> {
  const mode = role();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  await seed(pool);
  const bus = new PgEventBus(pool, config.databaseUrl);
  await bus.start();
  const logStore = await ClickHouseLogStore.connect(config.clickhouseUrl, config.clickhouseDatabase);
  const deployments = new PgDeploymentRepository(pool);
  const catalog = new PgCatalogRepository(pool);
  const faults = new FaultInjector();

  let worker: Worker | null = null;
  let workerDone: Promise<void> = Promise.resolve();
  if (mode !== 'api') {
    const clock = new Clock(config.fakeLatency);
    worker = await createWorker({
      address: config.temporalAddress,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      activities: createActivities({
        store: deployments,
        logs: new BufferedLogSink(logStore, bus),
        builder: new FakeBuilder(clock, faults),
        runner: new FakeInstanceRunner(clock, faults),
        router: new FakeRouter(clock),
        clock,
      }),
    });
    workerDone = worker.run();
    console.log(`worker polling task queue "${config.taskQueue}"`);
  }

  let server: Server | null = null;
  let scheduler: TemporalScheduler | null = null;
  if (mode !== 'worker') {
    scheduler = await TemporalScheduler.connect(config.temporalAddress, config.temporalNamespace, config.taskQueue);
    server = await listen(
      {
        catalog,
        deployments,
        commands: new DeploymentCommands(deployments, catalog, scheduler),
        logs: logStore,
        bus,
        ...(mode === 'all' && { faults }),
      },
      config.port,
    );
    console.log(`GraphQL API on http://localhost:${config.port}/graphql`);
  }

  const shutdown = async () => {
    server?.closeAllConnections();
    server?.close();
    worker?.shutdown();
    await workerDone;
    await scheduler?.close();
    await bus.stop();
    await logStore.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
