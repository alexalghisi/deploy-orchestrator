import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogLine } from '../src/domain/logs.js';
import { ClickHouseLogStore } from '../src/logs/clickhouseLogStore.js';
import { LogSequence } from '../src/logs/sequence.js';

const url = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
let store: ClickHouseLogStore;

beforeAll(async () => {
  store = await ClickHouseLogStore.connect(url, `deployorch_test_${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  await store.dropDatabase();
  await store.close();
});

function lines(deploymentId: string, count: number, seq = new LogSequence()): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    deploymentId,
    seq: seq.next(),
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)),
    stream: i % 2 === 0 ? 'build' : 'deploy',
    level: i === count - 1 ? 'error' : 'info',
    message: `line ${i} "quoted" \\ back\tslash`,
  }));
}

describe('ClickHouseLogStore', () => {
  it('round-trips lines, preserving order, timestamps and odd characters', async () => {
    const id = randomUUID();
    const written = lines(id, 5);
    await store.append(written);
    const page = await store.page(id, { limit: 10 });
    expect(page.lines).toEqual(written);
    expect(page.endCursor).toBe(written[4]!.seq);
  });

  it('pages with a keyset cursor and never repeats or skips a line', async () => {
    const id = randomUUID();
    const written = lines(id, 2_500);
    await store.append(written.slice(0, 1_200));
    await store.append(written.slice(1_200));
    await store.append(lines(randomUUID(), 300)); // noise from another deployment

    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await store.page(id, { after, limit: 1_000 });
      if (page.endCursor === null) break;
      seen.push(...page.lines.map((l) => l.seq));
      after = page.endCursor;
    }
    expect(seen).toEqual(written.map((l) => l.seq));
  });

  it('returns an empty page and null cursor past the end', async () => {
    const id = randomUUID();
    const written = lines(id, 3);
    await store.append(written);
    expect(await store.page(id, { after: written[2]!.seq, limit: 10 })).toEqual({ lines: [], endCursor: null });
  });
});
