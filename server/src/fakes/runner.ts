import { FatalError, TransientError, type FaultInjector } from './faults.js';
import { hang, type Clock } from './timing.js';
import type { Emit } from './builder.js';

export interface Instance {
  id: string;
  key: string;
  image: string;
  state: 'starting' | 'running';
  healthy: boolean;
}

/**
 * Stand-in for the service that runs containers. Instances are keyed by
 * deployment id: provisioning twice returns the same instance, and releasing
 * by key works even when the caller never learned the instance id.
 */
export class FakeInstanceRunner {
  private readonly instances = new Map<string, Instance>();
  private counter = 0;

  constructor(
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
  ) {}

  async provision(key: string, image: string, emit: Emit, signal: AbortSignal): Promise<Instance> {
    const existing = this.instances.get(key);
    if (existing) return existing;
    const fault = this.faults.take('provision');
    const instance: Instance = { id: `inst-${(++this.counter).toString(36)}`, key, image, state: 'starting', healthy: false };
    // the instance exists from here on, before the call returns: exactly what compensation must clean up
    this.instances.set(key, instance);
    emit('info', `Scheduling ${instance.id} (1 vCPU, 512 MB) in us-west2`);
    await this.clock.wait(500, signal);
    if (fault === 'transient') {
      emit('warn', 'Node drained during scheduling, retrying elsewhere');
      this.instances.delete(key);
      throw new TransientError('node drained');
    }
    if (fault === 'hang') {
      emit('warn', 'Waiting for capacity');
      await hang(signal);
    }
    emit('info', `Pulled ${image}`);
    await this.clock.wait(400, signal);
    instance.state = 'running';
    instance.healthy = fault !== 'fatal';
    emit('info', 'Container started');
    return instance;
  }

  async probe(instanceId: string, signal: AbortSignal): Promise<boolean> {
    const fault = this.faults.take('healthcheck');
    await this.clock.wait(300, signal);
    if (fault === 'hang') await hang(signal);
    if (fault === 'fatal') throw new FatalError('container exited with code 1');
    if (fault === 'transient') throw new TransientError('connection refused');
    return [...this.instances.values()].some((i) => i.id === instanceId && i.healthy);
  }

  async release(key: string): Promise<boolean> {
    return this.instances.delete(key);
  }

  list(): Instance[] {
    return [...this.instances.values()];
  }
}

/** Stand-in for the edge router: which instance receives traffic for a service in an environment. */
export class FakeRouter {
  private readonly routes = new Map<string, string>();

  constructor(private readonly clock: Clock) {}

  async route(serviceId: string, environmentId: string, instanceId: string): Promise<void> {
    await this.clock.wait(200);
    this.routes.set(`${serviceId}/${environmentId}`, instanceId);
  }

  current(serviceId: string, environmentId: string): string | undefined {
    return this.routes.get(`${serviceId}/${environmentId}`);
  }
}
