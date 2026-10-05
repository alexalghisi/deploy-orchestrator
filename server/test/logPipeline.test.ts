import { describe, expect, it } from 'vitest';
import type { LogLine, LogPage, LogStore } from '../src/domain/logs.js';
import { InMemoryEventBus } from '../src/events/bus.js';
import { BufferedLogSink } from '../src/logs/bufferedLogSink.js';
import { MemoryLogStore } from '../src/logs/memoryLogStore.js';
import { LogSequence } from '../src/logs/sequence.js';
import { tailLogs, type LogBatch } from '../src/logs/tailLogs.js';

class CountingStore implements LogStore {
  inserts: number[] = [];
  constructor(private readonly inner = new MemoryLogStore()) {}
  async append(lines: readonly LogLine[]) {
    this.inserts.push(lines.length);
    await this.inner.append(lines);
  }
  page(id: string, o: { after?: string | null; limit: number }): Promise<LogPage> {
    return this.inner.page(id, o);
  }
}

async function take<T>(iter: AsyncIterator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  while (out.length < n) {
    const next = await iter.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

describe('LogSequence', () => {
  it('stays strictly increasing even when the clock stands still or goes back', () => {
    const clock = [100n, 100n, 90n, 101n];
    const seq = new LogSequence(() => clock.shift() ?? 0n);
    const values = [seq.next(), seq.next(), seq.next(), seq.next()].map(BigInt);
    for (let i = 1; i < values.length; i++) expect(values[i]! > values[i - 1]!).toBe(true);
  });
});

describe('BufferedLogSink', () => {
  it('batches writes into one insert and announces only after it lands', async () => {
    const store = new CountingStore();
    const bus = new InMemoryEventBus();
    const announced = bus.subscribe('logsAppended');
    const sink = new BufferedLogSink(store, bus, { intervalMs: 1_000 });
    for (let i = 0; i < 10; i++) sink.write('d1', 'build', 'info', `line ${i}`);
    expect(store.inserts).toEqual([]);
    await sink.flush();
    expect(store.inserts).toEqual([10]);
    const [event] = await take(announced, 1);
    expect(event?.deploymentId).toBe('d1');
    expect((await store.page('d1', { after: null, limit: 100 })).endCursor).toBe(event?.seq);
  });

  it('flushes on its own once the batch is full', async () => {
    const store = new CountingStore();
    const sink = new BufferedLogSink(store, new InMemoryEventBus(), { maxBatch: 3, intervalMs: 1_000 });
    for (let i = 0; i < 7; i++) sink.write('d1', 'build', 'info', `${i}`);
    await sink.flush();
    expect(store.inserts).toEqual([3, 3, 1]);
  });
});

describe('tailLogs', () => {
  it('replays history in pages, then follows new lines without gaps or duplicates', async () => {
    const store = new MemoryLogStore();
    const bus = new InMemoryEventBus();
    const sink = new BufferedLogSink(store, bus, { intervalMs: 1 });
    for (let i = 0; i < 25; i++) sink.write('d1', 'build', 'info', `old ${i}`);
    sink.write('other', 'build', 'info', 'noise');
    await sink.flush();

    const tail = tailLogs(store, bus, 'd1', null, 10);
    const history = await take(tail, 3);
    expect(history.map((b) => b.lines.length)).toEqual([10, 10, 5]);

    const live: Promise<LogBatch[]> = take(tail, 1);
    sink.write('d1', 'deploy', 'info', 'new line');
    await sink.flush();
    const [batch] = await live;
    expect(batch?.lines.map((l) => l.message)).toEqual(['new line']);
    await tail.return(undefined);
  });

  it('resumes after a cursor', async () => {
    const store = new MemoryLogStore();
    const bus = new InMemoryEventBus();
    const sink = new BufferedLogSink(store, bus);
    for (let i = 0; i < 5; i++) sink.write('d1', 'build', 'info', `l${i}`);
    await sink.flush();
    const all = await store.page('d1', { limit: 5 });
    const tail = tailLogs(store, bus, 'd1', all.lines[2]!.seq);
    const [batch] = await take(tail, 1);
    expect(batch?.lines.map((l) => l.message)).toEqual(['l3', 'l4']);
    await tail.return(undefined);
  });
});
