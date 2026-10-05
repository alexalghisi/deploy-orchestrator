export const LOG_STREAMS = ['build', 'deploy'] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogLine {
  deploymentId: string;
  /** UInt64 in ClickHouse, kept as a decimal string so it survives JSON and GraphQL. */
  seq: string;
  ts: Date;
  stream: LogStream;
  level: LogLevel;
  message: string;
}

export interface LogPage {
  lines: LogLine[];
  /** Pass back as `after` to continue; null when the page was empty. */
  endCursor: string | null;
}

export interface LogStore {
  append(lines: readonly LogLine[]): Promise<void>;
  /** Lines with seq greater than `after`, oldest first. */
  page(deploymentId: string, options: { after?: string | null; limit: number }): Promise<LogPage>;
}

/** What activities write through. Implementations buffer, so callers must flush before they return. */
export interface LogSink {
  write(deploymentId: string, stream: LogStream, level: LogLevel, message: string): void;
  flush(): Promise<void>;
}
