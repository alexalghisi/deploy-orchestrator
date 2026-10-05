import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeploymentStatus } from '../src/domain/deploymentStatus.js';
import { InMemoryEventBus } from '../src/events/bus.js';
import { FakeBuilder } from '../src/fakes/builder.js';
import { FaultInjector } from '../src/fakes/faults.js';
import { FakeInstanceRunner, FakeRouter } from '../src/fakes/runner.js';
import { Clock } from '../src/fakes/timing.js';
import { BufferedLogSink } from '../src/logs/bufferedLogSink.js';
import { MemoryLogStore } from '../src/logs/memoryLogStore.js';
import { createActivities } from '../src/workflows/activities.js';
import { deployWorkflow, laneWorkflow, rollbackWorkflow } from '../src/workflows/index.js';
import { cancelDeploymentSignal, cancelSignal, enqueueSignal } from '../src/workflows/signals.js';
import { deploymentWorkflowId, laneWorkflowId, type LaneJob } from '../src/workflows/types.js';
import { MemoryDeploymentStore } from './support/memoryDeploymentStore.js';

const taskQueue = 'test-deploys';
const clock = new Clock(0);
const faults = new FaultInjector();
const store = new MemoryDeploymentStore();
const logStore = new MemoryLogStore();
const runner = new FakeInstanceRunner(clock, faults);
const router = new FakeRouter(clock);
const activities = createActivities({
  store,
  logs: new BufferedLogSink(logStore, new InMemoryEventBus()),
  builder: new FakeBuilder(clock, faults),
  runner,
  router,
  clock,
  healthCheckProbes: 3,
});

let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)),
    logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} },
  });
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
    // deliver cancellation to heartbeating activities quickly
    maxHeartbeatThrottleInterval: '50 milliseconds',
  });
  running = worker.run();
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
});

beforeEach(() => faults.clear());

let serviceCounter = 0;
function newService() {
  const serviceId = `svc-${++serviceCounter}`;
  return { serviceId, environmentId: 'production', repo: `github.com/acme/${serviceId}` };
}

function newDeploy(svc: ReturnType<typeof newService>, commitSha = randomUUID().replace(/-/g, '').slice(0, 7)) {
  const d = store.create({ serviceId: svc.serviceId, environmentId: svc.environmentId, commitSha });
  return { deploymentId: d.id, ...svc, commitSha };
}

const execDeploy = (input: ReturnType<typeof newDeploy>) =>
  env.client.workflow.execute(deployWorkflow, { taskQueue, workflowId: deploymentWorkflowId(input.deploymentId), args: [input] });

async function until(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const statusIs = (id: string, ...statuses: DeploymentStatus[]) => () => statuses.includes(store.statusOf(id) ?? 'QUEUED');

describe('deployWorkflow', () => {
  it('builds, pushes, provisions, checks health and goes ACTIVE', async () => {
    const input = newDeploy(newService());
    const result = await execDeploy(input);

    expect(result).toEqual({ deploymentId: input.deploymentId, status: 'ACTIVE' });
    expect(store.history.get(input.deploymentId)).toEqual(['QUEUED', 'BUILDING', 'DEPLOYING', 'ACTIVE']);
    const instance = runner.list().find((i) => i.key === input.deploymentId);
    expect(router.current(input.serviceId, input.environmentId)).toBe(instance?.id);
    expect(logStore.messages(input.deploymentId)).toEqual(
      expect.arrayContaining(['Build finished', expect.stringMatching(/^Traffic switched to inst-/)]),
    );
  });

  it('retries a transient build failure and still succeeds', async () => {
    faults.arm('build', 'transient', 1);
    const input = newDeploy(newService());
    const result = await execDeploy(input);

    expect(result.status).toBe('ACTIVE');
    const lines = logStore.messages(input.deploymentId);
    expect(lines).toContain('Retrying (attempt 2)');
    expect(lines.filter((l) => l.startsWith('Cloning'))).toHaveLength(2);
  });

  it('gives up after the retry budget and records FAILED with the reason', async () => {
    faults.arm('push', 'transient', 5);
    const input = newDeploy(newService());
    const result = await execDeploy(input);

    expect(result).toMatchObject({ status: 'FAILED', reason: 'registry unavailable' });
    expect((await store.get(input.deploymentId)).failureReason).toBe('registry unavailable');
    expect(logStore.messages(input.deploymentId).filter((l) => l.startsWith('Pushing'))).toHaveLength(3);
  });

  it('does not retry a fatal build error', async () => {
    faults.arm('build', 'fatal', 5);
    const input = newDeploy(newService());
    const result = await execDeploy(input);

    expect(result).toMatchObject({ status: 'FAILED', reason: 'TypeScript compilation failed' });
    expect(logStore.messages(input.deploymentId)).not.toContain('Retrying (attempt 2)');
  });

  it('fails a deploy whose health check never passes, releases its instance and keeps the old one live', async () => {
    const svc = newService();
    const first = newDeploy(svc);
    await execDeploy(first);

    faults.arm('provision', 'fatal', 1); // instance starts but never becomes healthy
    const second = newDeploy(svc);
    const result = await execDeploy(second);

    expect(result).toMatchObject({ status: 'FAILED', reason: 'Health check failed after 3 probes' });
    expect(runner.list().some((i) => i.key === second.deploymentId)).toBe(false);
    expect(store.statusOf(first.deploymentId)).toBe('ACTIVE');
    expect(router.current(svc.serviceId, svc.environmentId)).toBe(runner.list().find((i) => i.key === first.deploymentId)?.id);
  });

  it('cancels mid-build on signal and never provisions', async () => {
    faults.arm('build', 'hang', 1);
    const input = newDeploy(newService());
    const handle = await env.client.workflow.start(deployWorkflow, { taskQueue, workflowId: deploymentWorkflowId(input.deploymentId), args: [input] });
    await until(() => logStore.messages(input.deploymentId).includes('Build step is taking longer than usual'), 'build to hang');

    await handle.signal(cancelSignal, { reason: 'Cancelled by user' });
    expect(await handle.result()).toMatchObject({ status: 'CANCELLED', reason: 'Cancelled by user' });
    expect(store.history.get(input.deploymentId)).toEqual(['QUEUED', 'BUILDING', 'CANCELLED']);
    expect(runner.list().some((i) => i.key === input.deploymentId)).toBe(false);
  });

  it('compensates a cancel during provisioning by releasing the half-created instance', async () => {
    faults.arm('provision', 'hang', 1);
    const input = newDeploy(newService());
    const handle = await env.client.workflow.start(deployWorkflow, { taskQueue, workflowId: deploymentWorkflowId(input.deploymentId), args: [input] });
    await until(() => logStore.messages(input.deploymentId).includes('Waiting for capacity'), 'provisioning to hang');
    expect(runner.list().some((i) => i.key === input.deploymentId)).toBe(true);

    await handle.signal(cancelSignal, { reason: 'Cancelled by user' });
    expect(await handle.result()).toMatchObject({ status: 'CANCELLED' });
    expect(runner.list().some((i) => i.key === input.deploymentId)).toBe(false);
    expect(logStore.messages(input.deploymentId)).toContain('Released partially provisioned instance');
  });

  it('also compensates when the workflow itself is cancelled', async () => {
    faults.arm('provision', 'hang', 1);
    const input = newDeploy(newService());
    const handle = await env.client.workflow.start(deployWorkflow, { taskQueue, workflowId: deploymentWorkflowId(input.deploymentId), args: [input] });
    await until(() => logStore.messages(input.deploymentId).includes('Waiting for capacity'), 'provisioning to hang');

    await handle.cancel();
    expect(await handle.result()).toMatchObject({ status: 'CANCELLED' });
    expect(runner.list().some((i) => i.key === input.deploymentId)).toBe(false);
  });
});

describe('rollbackWorkflow', () => {
  it('redeploys an earlier image without building, and retires the current deployment', async () => {
    const svc = newService();
    const v1 = newDeploy(svc, 'aaaaaaa');
    const v2 = newDeploy(svc, 'bbbbbbb');
    await execDeploy(v1);
    await execDeploy(v2);
    const v1Image = (await store.get(v1.deploymentId)).image!;

    const rb = store.create({ serviceId: svc.serviceId, environmentId: svc.environmentId, commitSha: 'aaaaaaa', image: v1Image, rollbackOf: v1.deploymentId });
    const result = await env.client.workflow.execute(rollbackWorkflow, {
      taskQueue,
      workflowId: deploymentWorkflowId(rb.id),
      args: [{ deploymentId: rb.id, serviceId: svc.serviceId, environmentId: svc.environmentId, image: v1Image }],
    });

    expect(result.status).toBe('ACTIVE');
    expect(store.history.get(rb.id)).toEqual(['QUEUED', 'DEPLOYING', 'ACTIVE']);
    expect(store.statusOf(v2.deploymentId)).toBe('REMOVED');
    expect(runner.list().find((i) => i.key === rb.id)?.image).toBe(v1Image);
    expect(runner.list().some((i) => i.key === v2.deploymentId)).toBe(false);
    expect(logStore.messages(rb.id).some((l) => l.startsWith('Cloning'))).toBe(false);
  });
});

describe('laneWorkflow', () => {
  const submit = (svc: ReturnType<typeof newService>, job: LaneJob) =>
    env.client.workflow.signalWithStart(laneWorkflow, {
      taskQueue,
      workflowId: laneWorkflowId(svc.serviceId, svc.environmentId),
      args: [{ serviceId: svc.serviceId, environmentId: svc.environmentId }],
      signal: enqueueSignal,
      signalArgs: [job],
    });

  it('runs a deployment submitted to the lane', async () => {
    const svc = newService();
    const d = newDeploy(svc);
    await submit(svc, { kind: 'deploy', input: d });
    await until(statusIs(d.deploymentId, 'ACTIVE'), 'ACTIVE');
  });

  it('supersedes a running deployment when a newer one arrives', async () => {
    const svc = newService();
    faults.arm('build', 'hang', 1);
    const older = newDeploy(svc);
    await submit(svc, { kind: 'deploy', input: older });
    await until(statusIs(older.deploymentId, 'BUILDING'), 'older to build');

    const newer = newDeploy(svc);
    await submit(svc, { kind: 'deploy', input: newer });

    await until(statusIs(newer.deploymentId, 'ACTIVE'), 'newer to go ACTIVE');
    expect(store.statusOf(older.deploymentId)).toBe('CANCELLED');
    expect(logStore.messages(older.deploymentId)).toContain(`Superseded by deployment ${newer.deploymentId.slice(0, 8)}`);
    expect(runner.list().filter((i) => i.key === older.deploymentId)).toEqual([]);
  });

  it('drops queued deployments that a newer one overtakes; only the newest runs', async () => {
    const svc = newService();
    faults.arm('build', 'hang', 1);
    const first = newDeploy(svc);
    const second = newDeploy(svc);
    const third = newDeploy(svc);
    await submit(svc, { kind: 'deploy', input: first });
    await until(statusIs(first.deploymentId, 'BUILDING'), 'first to build');
    await submit(svc, { kind: 'deploy', input: second });
    await submit(svc, { kind: 'deploy', input: third });

    await until(statusIs(third.deploymentId, 'ACTIVE'), 'third to go ACTIVE');
    expect(store.history.get(second.deploymentId)).toEqual(['QUEUED', 'CANCELLED']);
    expect(store.statusOf(first.deploymentId)).toBe('CANCELLED');
  });

  it('cancels through the lane, wherever the deployment is', async () => {
    const svc = newService();
    faults.arm('build', 'hang', 1);
    const d = newDeploy(svc);
    await submit(svc, { kind: 'deploy', input: d });
    await until(statusIs(d.deploymentId, 'BUILDING'), 'build to start');

    await env.client.workflow
      .getHandle(laneWorkflowId(svc.serviceId, svc.environmentId))
      .signal(cancelDeploymentSignal, { deploymentId: d.deploymentId, reason: 'Cancelled by user' });
    await until(statusIs(d.deploymentId, 'CANCELLED'), 'CANCELLED');
  });

  it('serialises a rollback behind the deploy in front of it', async () => {
    const svc = newService();
    const v1 = newDeploy(svc);
    await submit(svc, { kind: 'deploy', input: v1 });
    await until(statusIs(v1.deploymentId, 'ACTIVE'), 'v1 ACTIVE');
    const v2 = newDeploy(svc);
    await submit(svc, { kind: 'deploy', input: v2 });
    await until(statusIs(v2.deploymentId, 'ACTIVE'), 'v2 ACTIVE');

    const image = (await store.get(v1.deploymentId)).image!;
    const rb = store.create({ serviceId: svc.serviceId, environmentId: svc.environmentId, image, rollbackOf: v1.deploymentId });
    await submit(svc, { kind: 'rollback', input: { deploymentId: rb.id, serviceId: svc.serviceId, environmentId: svc.environmentId, image } });

    await until(statusIs(rb.id, 'ACTIVE'), 'rollback ACTIVE');
    expect(store.statusOf(v2.deploymentId)).toBe('REMOVED');
  });
});
