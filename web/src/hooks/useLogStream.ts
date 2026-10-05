import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Client } from '@urql/core';
import { DeploymentLogsSubscription } from '../graphql/operations';
import type { LogLine } from '../graphql/types';

export const LogClientContext = createContext<Client | null>(null);

export interface LogStream {
  lines: readonly LogLine[];
  /** Bumped whenever `lines` grows; `lines` itself is appended in place. */
  version: number;
  error: string | null;
  retry(): void;
}

/**
 * Follows a deployment's log. Lines are appended to a ref and the component
 * re-renders at most once per animation frame, so a burst of thousands of
 * lines costs one render. After an error, retry resumes from the last cursor.
 */
export function useLogStream(deploymentId: string | null): LogStream {
  const client = useContext(LogClientContext);
  const lines = useRef<LogLine[]>([]);
  const cursor = useRef<string | null>(null);
  const frame = useRef<number | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    lines.current = [];
    cursor.current = null;
    setVersion((v) => v + 1);
    setError(null);
  }, [deploymentId]);

  useEffect(() => {
    if (!client || !deploymentId) return;
    const { unsubscribe } = client
      .subscription(DeploymentLogsSubscription, { deploymentId, after: cursor.current })
      .subscribe((result) => {
        if (result.error) {
          setError(result.error.graphQLErrors[0]?.message ?? 'Log stream disconnected');
          return;
        }
        const batch = result.data?.deploymentLogs;
        if (!batch || batch.lines.length === 0) return;
        lines.current.push(...batch.lines);
        cursor.current = batch.cursor;
        frame.current ??= requestAnimationFrame(() => {
          frame.current = null;
          setVersion((v) => v + 1);
        });
      });
    return () => {
      unsubscribe();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [client, deploymentId, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((a) => a + 1);
  }, []);

  return { lines: lines.current, version, error, retry };
}
