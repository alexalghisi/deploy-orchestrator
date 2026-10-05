import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import type { DeploymentStatus } from '../domain/deploymentStatus.js';
import type { LogLevel, LogSink, LogStream } from '../domain/logs.js';
import type { DeploymentStore } from '../domain/ports.js';
import { InvalidTransitionError } from '../domain/deploymentStatus.js';
import type { FakeBuilder } from '../fakes/builder.js';
import { FatalError } from '../fakes/faults.js';
import type { FakeInstanceRunner, FakeRouter } from '../fakes/runner.js';
import type { Clock } from '../fakes/timing.js';

export interface ActivityDeps {
  store: DeploymentStore;
  logs: LogSink;
  builder: FakeBuilder;
  runner: FakeInstanceRunner;
  router: FakeRouter;
  clock: Clock;
  /** Probes before a health check gives up. */
  healthCheckProbes?: number;
}

export interface StatusUpdate {
  deploymentId: string;
  status: DeploymentStatus;
  image?: string;
  failureReason?: string;
  message?: string;
}

/**
 * Activities are built from injected dependencies so the same code runs
 * against Postgres/ClickHouse in the app and in-memory fakes in tests.
 */
export function createActivities(deps: ActivityDeps) {
  const { store, logs, builder, runner, router, clock } = deps;
  const probes = deps.healthCheckProbes ?? 10;

  const heartbeat = () => Context.current().heartbeat();
  const cancelled = () => Context.current().cancellationSignal;

  /** Runs `fn` with a logger bound to the deployment, and always flushes before returning. */
  async function logged<T>(
    deploymentId: string,
    stream: LogStream,
    fn: (emit: (level: LogLevel, message: string) => void) => Promise<T>,
  ): Promise<T> {
    const emit = (level: LogLevel, message: string) => logs.write(deploymentId, stream, level, message);
    const { attempt } = Context.current().info;
    if (attempt > 1) emit('warn', `Retrying (attempt ${attempt})`);
    // cancellation reaches an activity only through a heartbeat response
    const keepAlive = setInterval(heartbeat, 250);
    try {
      return await fn(emit);
    } catch (err) {
      // report as cancelled rather than failed, whatever the fake threw on abort
      if (Context.current().cancellationSignal.aborted) {
        emit('warn', 'Cancelled');
        throw new CancelledFailure('activity cancelled');
      }
      throw err;
    } finally {
      clearInterval(keepAlive);
      await logs.flush();
    }
  }

  /** Turns the fakes' error vocabulary into Temporal's: fatal errors must not be retried. */
  function rethrow(err: unknown): never {
    if (err instanceof FatalError) throw ApplicationFailure.nonRetryable(err.message, 'FatalError');
    if (err instanceof InvalidTransitionError) throw ApplicationFailure.nonRetryable(err.message, 'InvalidTransition');
    throw err;
  }

  return {
    async recordStatus(update: StatusUpdate): Promise<void> {
      try {
        await store.transition(update.deploymentId, update.status, {
          ...(update.image !== undefined && { image: update.image }),
          ...(update.failureReason !== undefined && { failureReason: update.failureReason }),
        });
      } catch (err) {
        rethrow(err);
      }
      if (update.message) {
        logs.write(update.deploymentId, 'deploy', update.status === 'FAILED' ? 'error' : 'info', update.message);
        await logs.flush();
      }
    },

    /** Cancels a deployment that never left the queue; anything else is left alone. */
    async cancelQueued(deploymentId: string, reason: string): Promise<boolean> {
      const current = await store.get(deploymentId);
      if (current.status !== 'QUEUED') return false;
      await store.transition(deploymentId, 'CANCELLED');
      logs.write(deploymentId, 'deploy', 'info', reason);
      await logs.flush();
      return true;
    },

    async buildImage(input: { deploymentId: string; repo: string; commitSha: string }): Promise<{ image: string }> {
      return logged(input.deploymentId, 'build', (emit) =>
        builder.build(input, emit, cancelled(), heartbeat).catch(rethrow),
      );
    },

    async pushImage(input: { deploymentId: string; image: string }): Promise<void> {
      return logged(input.deploymentId, 'build', async (emit) => {
        await builder.push(input.image, emit, cancelled()).catch(rethrow);
      });
    },

    async provisionInstance(input: { deploymentId: string; image: string }): Promise<{ instanceId: string }> {
      return logged(input.deploymentId, 'deploy', async (emit) => {
        const instance = await runner.provision(input.deploymentId, input.image, emit, cancelled()).catch(rethrow);
        return { instanceId: instance.id };
      });
    },

    async healthCheck(input: { deploymentId: string; instanceId: string }): Promise<void> {
      return logged(input.deploymentId, 'deploy', async (emit) => {
        for (let probe = 1; probe <= probes; probe++) {
          const healthy = await runner.probe(input.instanceId, cancelled()).catch(rethrow);
          if (healthy) {
            emit('info', `Health check passed (GET /health 200, probe ${probe})`);
            return;
          }
          emit('warn', `Health check probe ${probe}/${probes}: GET /health returned 503`);
          await clock.wait(500, cancelled());
        }
        throw ApplicationFailure.nonRetryable(`Health check failed after ${probes} probes`, 'HealthCheckFailed');
      });
    },

    async findActive(input: { serviceId: string; environmentId: string }): Promise<{ deploymentId: string } | null> {
      const active = await store.findActive(input.serviceId, input.environmentId);
      return active ? { deploymentId: active.id } : null;
    },

    /** Routes traffic to the new instance and flips ACTIVE in one transaction. Both halves are idempotent. */
    async switchTraffic(input: {
      deploymentId: string;
      serviceId: string;
      environmentId: string;
      instanceId: string;
    }): Promise<void> {
      return logged(input.deploymentId, 'deploy', async (emit) => {
        await router.route(input.serviceId, input.environmentId, input.instanceId);
        await store.promote(input.deploymentId).catch(rethrow);
        emit('info', `Traffic switched to ${input.instanceId}`);
      });
    },

    async teardownPrevious(input: { deploymentId: string; previousDeploymentId: string }): Promise<void> {
      return logged(input.deploymentId, 'deploy', async (emit) => {
        const removed = await runner.release(input.previousDeploymentId);
        if (removed) emit('info', `Stopped previous deployment ${input.previousDeploymentId.slice(0, 8)}`);
      });
    },

    /** Compensation: removes whatever this deployment provisioned, even half-way. */
    async releaseInstance(input: { deploymentId: string }): Promise<void> {
      return logged(input.deploymentId, 'deploy', async (emit) => {
        if (await runner.release(input.deploymentId)) emit('info', 'Released partially provisioned instance');
      });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
