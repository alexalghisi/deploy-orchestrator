/**
 * An unbounded push queue exposed as an async iterator. Used to bridge
 * listener callbacks to GraphQL subscriptions. `onClose` runs once when the
 * consumer stops (return(), abort, or end()).
 */
export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly buffer: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly onClose: () => void = () => {}) {}

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.waiting.shift();
    if (resolve) resolve({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    for (const resolve of this.waiting.splice(0)) resolve({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift()!, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    this.buffer.length = 0;
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
