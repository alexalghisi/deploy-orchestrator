/**
 * ClickHouse log store: bulk ingest throughput, and how keyset pagination
 * compares to OFFSET when reading the end of a very long log.
 *
 *   npm run bench:logs            (CLICKHOUSE_URL, default http://localhost:8124)
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { LogLine } from '../src/domain/logs.js';
import { ClickHouseLogStore } from '../src/logs/clickhouseLogStore.js';
import { LogSequence } from '../src/logs/sequence.js';
import { summary } from './stats.js';

const url = process.env.CLICKHOUSE_URL ?? 'http://localhost:8124';
const LINES = Number(process.env.LINES ?? 1_000_000);
const NOISE_DEPLOYMENTS = 20;
const BATCH = 10_000;
const PAGE = 1_000;

const store = await ClickHouseLogStore.connect(url, `deployorch_bench_${randomUUID().slice(0, 8)}`);
const seq = new LogSequence();
const now = new Date();

function batch(deploymentId: string, size: number): LogLine[] {
  return Array.from({ length: size }, (_, i) => ({
    deploymentId,
    seq: seq.next(),
    ts: now,
    stream: 'build',
    level: 'info',
    message: `#${i} RUN npm ci  added 812 packages, and audited 813 packages in 9s ${randomUUID()}`,
  }));
}

try {
  const target = randomUUID();
  const started = performance.now();
  for (let written = 0; written < LINES; written += BATCH) await store.append(batch(target, BATCH));
  const ingestSeconds = (performance.now() - started) / 1000;
  console.log(`ingest: ${LINES.toLocaleString('en')} lines in ${ingestSeconds.toFixed(1)} s = ${Math.round(LINES / ingestSeconds).toLocaleString('en')} lines/s (batches of ${BATCH.toLocaleString('en')})`);

  for (let i = 0; i < NOISE_DEPLOYMENTS; i++) await store.append(batch(randomUUID(), 25_000));
  console.log(`noise: ${(NOISE_DEPLOYMENTS * 25_000).toLocaleString('en')} lines from ${NOISE_DEPLOYMENTS} other deployments`);

  // cursor for the last page
  const all: string[] = [];
  let after: string | null = null;
  const pageTimes: number[] = [];
  for (;;) {
    const t = performance.now();
    const page = await store.page(target, { after, limit: 10_000 });
    pageTimes.push(performance.now() - t);
    if (page.endCursor === null) break;
    all.push(page.lines[0]!.seq);
    after = page.endCursor;
  }
  console.log(summary('full scan in 10k pages (keyset)', pageTimes));

  const lastCursor = (await store.page(target, { after: all.at(-1)!, limit: 1 })).endCursor!;
  const keyset: number[] = [];
  const offset: number[] = [];
  for (let i = 0; i < 30; i++) {
    let t = performance.now();
    await store.page(target, { after: lastCursor, limit: PAGE });
    keyset.push(performance.now() - t);
    t = performance.now();
    await store.pageByOffset(target, LINES - PAGE * 2, PAGE);
    offset.push(performance.now() - t);
  }
  console.log(summary(`page of ${PAGE} near the end, keyset`, keyset));
  console.log(summary(`page of ${PAGE} near the end, OFFSET`, offset));
} finally {
  await store.dropDatabase();
  await store.close();
}
