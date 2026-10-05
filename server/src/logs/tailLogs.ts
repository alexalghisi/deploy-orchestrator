import type { LogLine, LogStore } from '../domain/logs.js';
import type { EventBus } from '../events/bus.js';

export interface LogBatch {
  lines: LogLine[];
  cursor: string;
}

/**
 * Streams a deployment's log from `after` onwards: history first, in pages,
 * then new lines as they are announced. It subscribes before the first read,
 * so a line written in between is either in the read or triggers another one.
 */
export async function* tailLogs(
  store: LogStore,
  bus: EventBus,
  deploymentId: string,
  after: string | null,
  pageSize = 1000,
): AsyncGenerator<LogBatch> {
  const announcements = bus.subscribe('logsAppended');
  let cursor = after;
  try {
    for (;;) {
      const page = await store.page(deploymentId, { after: cursor, limit: pageSize });
      if (page.endCursor !== null) {
        cursor = page.endCursor;
        yield { lines: page.lines, cursor };
        if (page.lines.length === pageSize) continue;
      }
      if (!(await waitForNewer(announcements, deploymentId, cursor))) return;
    }
  } finally {
    await announcements.return();
  }
}

async function waitForNewer(
  announcements: AsyncIterator<{ deploymentId: string; seq: string }>,
  deploymentId: string,
  cursor: string | null,
): Promise<boolean> {
  const seen = BigInt(cursor ?? '0');
  for (;;) {
    const next = await announcements.next();
    if (next.done) return false;
    if (next.value.deploymentId === deploymentId && BigInt(next.value.seq) > seen) return true;
  }
}
