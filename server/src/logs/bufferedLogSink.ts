import type { LogLevel, LogLine, LogSink, LogStore, LogStream } from '../domain/logs.js';
import type { EventBus } from '../events/bus.js';
import { LogSequence } from './sequence.js';

export interface BufferedLogSinkOptions {
  /** Flush when this many lines are waiting. */
  maxBatch?: number;
  /** Flush at least this often while lines are waiting. */
  intervalMs?: number;
  sequence?: LogSequence;
  now?: () => Date;
}

/**
 * Batches lines into ClickHouse inserts (one insert per line would create a
 * part per line) and announces them only after the insert succeeds. Because
 * a line is never announced before it is readable, a subscriber that listens
 * first and then reads from the store cannot miss anything.
 */
export class BufferedLogSink implements LogSink {
  private buffer: LogLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private readonly maxBatch: number;
  private readonly intervalMs: number;
  private readonly sequence: LogSequence;
  private readonly now: () => Date;

  constructor(
    private readonly store: LogStore,
    private readonly bus: EventBus,
    options: BufferedLogSinkOptions = {},
  ) {
    this.maxBatch = options.maxBatch ?? 500;
    this.intervalMs = options.intervalMs ?? 50;
    this.sequence = options.sequence ?? new LogSequence();
    this.now = options.now ?? (() => new Date());
  }

  write(deploymentId: string, stream: LogStream, level: LogLevel, message: string): void {
    this.buffer.push({ deploymentId, seq: this.sequence.next(), ts: this.now(), stream, level, message });
    if (this.buffer.length >= this.maxBatch) void this.flush().catch(() => {});
    else this.timer ??= setTimeout(() => void this.flush().catch(() => {}), this.intervalMs);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.buffer;
    this.buffer = [];
    // chained so batches land, and are announced, in the order they were written
    const next = this.inflight.then(() => this.persist(batch));
    this.inflight = next.catch(() => {});
    return next;
  }

  private async persist(batch: LogLine[]): Promise<void> {
    if (batch.length === 0) return;
    await this.store.append(batch);
    const latest = new Map<string, string>();
    for (const line of batch) latest.set(line.deploymentId, line.seq);
    await Promise.all([...latest].map(([deploymentId, seq]) => this.bus.publish('logsAppended', { deploymentId, seq })));
  }
}
