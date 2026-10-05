import { Client, fetchExchange } from '@urql/core';
import { createCacheExchange } from './cache';

const url = '/graphql';

/** The app's client: normalized cache, optimistic updates, subscriptions over SSE. */
export function createClient(): Client {
  return new Client({ url, exchanges: [createCacheExchange(), fetchExchange], fetchSubscriptions: true });
}

/**
 * Logs bypass the normalized cache: they are append-only, can run to tens of
 * thousands of lines, and have no identity worth normalizing.
 */
export function createLogClient(): Client {
  return new Client({ url, exchanges: [fetchExchange], fetchSubscriptions: true, requestPolicy: 'network-only' });
}
