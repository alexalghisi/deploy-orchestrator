import { LOG_LEVELS, LOG_STREAMS, type LogLine } from '../../domain/logs.js';
import type { LogBatch } from '../../logs/tailLogs.js';
import { builder } from '../builder.js';

export const LogLineRef = builder.objectRef<LogLine>('LogLine');

LogLineRef.implement({
  fields: (t) => ({
    seq: t.exposeString('seq', { description: 'Monotonic within a deployment; also the pagination cursor.' }),
    ts: t.field({ type: 'DateTime', resolve: (l) => l.ts }),
    stream: t.field({ type: builder.enumType('LogStream', { values: LOG_STREAMS }), resolve: (l) => l.stream }),
    level: t.field({ type: builder.enumType('LogLevel', { values: LOG_LEVELS }), resolve: (l) => l.level }),
    message: t.exposeString('message'),
  }),
});

export interface LogConnection {
  lines: LogLine[];
  endCursor: string | null;
  hasMore: boolean;
}

export const LogConnectionRef = builder.objectRef<LogConnection>('LogConnection').implement({
  fields: (t) => ({
    lines: t.field({ type: [LogLineRef], resolve: (c) => c.lines }),
    endCursor: t.exposeString('endCursor', { nullable: true }),
    hasMore: t.exposeBoolean('hasMore'),
  }),
});

export const LogBatchRef = builder.objectRef<LogBatch>('LogBatch').implement({
  fields: (t) => ({
    lines: t.field({ type: [LogLineRef], resolve: (b) => b.lines }),
    cursor: t.exposeString('cursor'),
  }),
});
