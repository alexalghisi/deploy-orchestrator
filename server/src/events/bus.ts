import type { DeploymentStatus } from '../domain/deploymentStatus.js';
import { AsyncQueue } from './asyncQueue.js';

export interface DeploymentChanged {
  id: string;
  projectId: string;
  serviceId: string;
  environmentId: string;
  status: DeploymentStatus;
}

export interface LogsAppended {
  deploymentId: string;
  /** Highest seq now readable from the log store. */
  seq: string;
}

export interface Events {
  deploymentChanged: DeploymentChanged;
  logsAppended: LogsAppended;
}

export type Topic = keyof Events;

export interface EventBus {
  publish<K extends Topic>(topic: K, payload: Events[K]): Promise<void>;
  subscribe<K extends Topic>(topic: K): AsyncQueue<Events[K]>;
}

/** Fans one incoming stream of events out to any number of local subscribers. */
export class Fanout {
  private readonly subscribers: { [K in Topic]: Set<AsyncQueue<Events[K]>> } = {
    deploymentChanged: new Set(),
    logsAppended: new Set(),
  };

  deliver<K extends Topic>(topic: K, payload: Events[K]): void {
    for (const queue of this.subscribers[topic] as Set<AsyncQueue<Events[K]>>) queue.push(payload);
  }

  subscribe<K extends Topic>(topic: K): AsyncQueue<Events[K]> {
    const set = this.subscribers[topic] as Set<AsyncQueue<Events[K]>>;
    const queue: AsyncQueue<Events[K]> = new AsyncQueue(() => set.delete(queue));
    set.add(queue);
    return queue;
  }

  closeAll(): void {
    for (const set of Object.values(this.subscribers)) for (const q of [...set]) q.end();
  }
}

export class InMemoryEventBus implements EventBus {
  private readonly fanout = new Fanout();

  async publish<K extends Topic>(topic: K, payload: Events[K]): Promise<void> {
    this.fanout.deliver(topic, payload);
  }

  subscribe<K extends Topic>(topic: K): AsyncQueue<Events[K]> {
    return this.fanout.subscribe(topic);
  }
}
