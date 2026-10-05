/**
 * Per-process monotonic sequence: microseconds since the epoch, shifted left
 * by 10 bits, plus a counter for lines written in the same microsecond. It
 * orders lines across activities of one deployment because those run one
 * after another, and it never goes backwards if the wall clock does.
 */
export class LogSequence {
  private last = 0n;

  constructor(private readonly nowMicros: () => bigint = defaultNowMicros) {}

  next(): string {
    const candidate = this.nowMicros() << 10n;
    this.last = candidate > this.last ? candidate : this.last + 1n;
    return this.last.toString();
  }
}

const originMicros = BigInt(Date.now()) * 1000n;
const originHr = process.hrtime.bigint();

function defaultNowMicros(): bigint {
  return originMicros + (process.hrtime.bigint() - originHr) / 1000n;
}
