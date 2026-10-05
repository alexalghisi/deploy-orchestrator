export const FAULT_TARGETS = ['build', 'push', 'provision', 'healthcheck'] as const;
export type FaultTarget = (typeof FAULT_TARGETS)[number];

/**
 * transient: fails like a flaky network and succeeds on retry.
 * fatal: fails in a way retrying cannot fix (bad Dockerfile, crashing app).
 * hang: never finishes on its own; only cancellation ends it.
 */
export type FaultKind = 'transient' | 'fatal' | 'hang';

interface Armed {
  kind: FaultKind;
  remaining: number;
}

/** Lets tests and the demo make the fake services misbehave on purpose. */
export class FaultInjector {
  private readonly armed = new Map<FaultTarget, Armed>();

  arm(target: FaultTarget, kind: FaultKind, times = 1): void {
    this.armed.set(target, { kind, remaining: times });
  }

  clear(): void {
    this.armed.clear();
  }

  /** Consumes one armed fault for `target`, if any. */
  take(target: FaultTarget): FaultKind | null {
    const fault = this.armed.get(target);
    if (!fault) return null;
    fault.remaining -= 1;
    if (fault.remaining <= 0) this.armed.delete(target);
    return fault.kind;
  }
}

export class TransientError extends Error {
  override name = 'TransientError';
}

export class FatalError extends Error {
  override name = 'FatalError';
}
