import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { LOG_LEVELS, LOG_STREAMS, type LogLevel, type LogLine, type LogPage, type LogStore, type LogStream } from '../domain/logs.js';

interface Row {
  deployment_id: string;
  seq_text: string;
  ts_ms: string | number;
  stream: string;
  level: string;
  message: string;
}

const TABLE = 'deployment_logs';

/**
 * Ordered by (deployment_id, seq): every read is "one deployment, after this
 * cursor", which becomes a range scan on the primary key regardless of how
 * many lines other deployments have written.
 */
export class ClickHouseLogStore implements LogStore {
  private constructor(
    private readonly client: ClickHouseClient,
    private readonly database: string,
  ) {}

  static async connect(url: string, database: string): Promise<ClickHouseLogStore> {
    const bootstrap = createClient({ url });
    await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
    await bootstrap.close();
    const store = new ClickHouseLogStore(createClient({ url, database }), database);
    await store.client.command({
      query: `CREATE TABLE IF NOT EXISTS ${TABLE} (
        deployment_id UUID,
        seq UInt64,
        ts DateTime64(3, 'UTC'),
        stream LowCardinality(String),
        level LowCardinality(String),
        message String CODEC(ZSTD(3))
      ) ENGINE = MergeTree
      ORDER BY (deployment_id, seq)`,
    });
    return store;
  }

  async append(lines: readonly LogLine[]): Promise<void> {
    if (lines.length === 0) return;
    await this.client.insert({
      table: TABLE,
      format: 'JSONEachRow',
      values: lines.map((l) => ({
        deployment_id: l.deploymentId,
        seq: l.seq,
        ts: l.ts.toISOString(),
        stream: l.stream,
        level: l.level,
        message: l.message,
      })),
      // ts arrives as an ISO-8601 string
      clickhouse_settings: { date_time_input_format: 'best_effort' },
    });
  }

  async page(deploymentId: string, options: { after?: string | null; limit: number }): Promise<LogPage> {
    const result = await this.client.query({
      // seq as text: a UInt64 does not fit in a JS number
      query: `SELECT deployment_id, toString(seq) AS seq_text, toUnixTimestamp64Milli(ts) AS ts_ms,
                     stream, level, message
                FROM ${TABLE}
               WHERE deployment_id = {deploymentId: UUID} AND seq > {after: UInt64}
               ORDER BY seq
               LIMIT {limit: UInt32}`,
      query_params: { deploymentId, after: options.after ?? '0', limit: options.limit },
      format: 'JSONEachRow',
    });
    const rows = await result.json<Row>();
    const lines = rows.map(toLogLine);
    return { lines, endCursor: lines.at(-1)?.seq ?? null };
  }

  /** OFFSET pagination, kept only so the benchmark can compare against it. */
  async pageByOffset(deploymentId: string, offset: number, limit: number): Promise<number> {
    const result = await this.client.query({
      query: `SELECT seq FROM ${TABLE} WHERE deployment_id = {deploymentId: UUID}
               ORDER BY seq LIMIT {limit: UInt32} OFFSET {offset: UInt64}`,
      query_params: { deploymentId, offset, limit },
      format: 'JSONEachRow',
    });
    return (await result.json<{ seq: string }>()).length;
  }

  async dropDatabase(): Promise<void> {
    await this.client.command({ query: `DROP DATABASE IF EXISTS ${this.database}` });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function toLogLine(row: Row): LogLine {
  return {
    deploymentId: row.deployment_id,
    seq: row.seq_text,
    ts: new Date(Number(row.ts_ms)),
    stream: oneOf(LOG_STREAMS, row.stream, 'deploy'),
    level: oneOf(LOG_LEVELS, row.level, 'info'),
    message: row.message,
  };
}

function oneOf<T extends string>(allowed: readonly T[], value: string, fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export type { LogLevel, LogStream };
