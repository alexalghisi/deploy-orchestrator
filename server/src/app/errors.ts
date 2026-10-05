export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'NOT_CANCELLABLE'
  | 'NOT_ROLLBACKABLE'
  | 'INVALID_INPUT'
  | 'SCHEDULING_FAILED';

/** An expected, user-facing failure. The API passes its message and code through to clients. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
