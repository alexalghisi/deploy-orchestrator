import { Client, getOperationName, makeResult, type Exchange, type Operation, type OperationResult } from '@urql/core';
import type { ReactNode } from 'react';
import { Provider } from 'urql';
import { filter, fromPromise, mergeMap, pipe } from 'wonka';
import { ToastProvider } from '../components/Toasts';
import { createCacheExchange } from '../graphql/cache';

export interface FakeResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

type Handler = (variables: Record<string, unknown>) => FakeResponse | Promise<FakeResponse>;

/**
 * A terminating exchange that answers operations by name, so component tests
 * run the real normalized cache, optimistic updates included.
 */
function fakeExchange(handlers: Record<string, Handler>): Exchange {
  return () => (ops$) =>
    pipe(
      ops$,
      filter((op: Operation) => op.kind !== 'teardown'),
      mergeMap((op: Operation) => {
        const name = getOperationName(op.query) ?? '';
        const handler = handlers[name];
        if (!handler) throw new Error(`No fake handler for ${name}`);
        const response: Promise<OperationResult> = Promise.resolve(handler(op.variables as Record<string, unknown>)).then((r) =>
          makeResult(op, { data: r.data ?? null, errors: r.errors }),
        );
        return fromPromise(response);
      }),
    );
}

export function createFakeClient(handlers: Record<string, Handler>): Client {
  return new Client({ url: 'http://fake/graphql', exchanges: [createCacheExchange(), fakeExchange(handlers)] });
}

export function withClient(client: Client, ui: ReactNode) {
  return (
    <Provider value={client}>
      <ToastProvider>{ui}</ToastProvider>
    </Provider>
  );
}

/** A promise you resolve from the test, to hold a response in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
