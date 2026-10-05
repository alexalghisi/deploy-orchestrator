function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

export const config = {
  databaseUrl: env('DATABASE_URL', 'postgres://synckit:synckit@localhost:5432/deployorch_dev'),
  clickhouseUrl: env('CLICKHOUSE_URL', 'http://localhost:8124'),
  clickhouseDatabase: env('CLICKHOUSE_DATABASE', 'deployorch'),
  temporalAddress: env('TEMPORAL_ADDRESS', 'localhost:7233'),
  temporalNamespace: env('TEMPORAL_NAMESPACE', 'default'),
  taskQueue: env('TASK_QUEUE', 'deploys'),
  port: intEnv('PORT', 4000),
  /** Multiplier for the fake builder and runner latencies; 0 makes them instant. */
  fakeLatency: Number(env('FAKE_LATENCY', '1')),
} as const;
