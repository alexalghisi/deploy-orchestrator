export class AbortedError extends Error {
  override name = 'AbortedError';
}

/** setTimeout that rejects when `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Waits until `signal` aborts. Used for faults of kind "hang". */
export function hang(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(new AbortedError('aborted'));
    signal?.addEventListener('abort', () => reject(new AbortedError('aborted')), { once: true });
  });
}

/** Scales the fake services' latencies; 0 in tests, 1 in the demo. */
export class Clock {
  constructor(private readonly factor: number) {}

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return this.factor === 0 ? (signal?.aborted ? Promise.reject(new AbortedError('aborted')) : Promise.resolve()) : delay(ms * this.factor, signal);
  }
}
