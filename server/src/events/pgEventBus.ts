import pg from 'pg';
import { isDeploymentStatus } from '../domain/deploymentStatus.js';
import type { Pool } from '../db/pool.js';
import type { AsyncQueue } from './asyncQueue.js';
import { Fanout, type DeploymentChanged, type EventBus, type Events, type LogsAppended, type Topic } from './bus.js';

const CHANNELS: Record<Topic, string> = {
  deploymentChanged: 'deployment_changed',
  logsAppended: 'deployment_logs',
};

/**
 * Cross-process events over Postgres LISTEN/NOTIFY. Notifications are
 * delivered on commit, which is what makes status events trustworthy: the
 * trigger on `deployments` publishes them, so no code path can forget to.
 * Payloads are pointers (ids, sequence numbers); subscribers read the data.
 */
export class PgEventBus implements EventBus {
  private readonly fanout = new Fanout();
  private listener: pg.Client | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly connectionString: string,
  ) {}

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    await client.connect();
    client.on('notification', (msg) => this.onNotification(msg.channel, msg.payload));
    for (const channel of Object.values(CHANNELS)) await client.query(`LISTEN ${channel}`);
    this.listener = client;
  }

  async stop(): Promise<void> {
    this.fanout.closeAll();
    await this.listener?.end();
    this.listener = null;
  }

  async publish<K extends Topic>(topic: K, payload: Events[K]): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [CHANNELS[topic], JSON.stringify(payload)]);
  }

  subscribe<K extends Topic>(topic: K): AsyncQueue<Events[K]> {
    return this.fanout.subscribe(topic);
  }

  private onNotification(channel: string, payload: string | undefined): void {
    if (!payload) return;
    const data: unknown = JSON.parse(payload);
    if (channel === CHANNELS.deploymentChanged && isDeploymentChanged(data)) this.fanout.deliver('deploymentChanged', data);
    if (channel === CHANNELS.logsAppended && isLogsAppended(data)) this.fanout.deliver('logsAppended', data);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDeploymentChanged(v: unknown): v is DeploymentChanged {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.serviceId === 'string' &&
    typeof v.environmentId === 'string' &&
    typeof v.projectId === 'string' &&
    typeof v.status === 'string' &&
    isDeploymentStatus(v.status)
  );
}

function isLogsAppended(v: unknown): v is LogsAppended {
  return isRecord(v) && typeof v.deploymentId === 'string' && typeof v.seq === 'string';
}
