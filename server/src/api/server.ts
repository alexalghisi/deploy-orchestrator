import { createServer, type Server } from 'node:http';
import { createGraphQLError, createYoga } from 'graphql-yoga';
import { DomainError } from '../app/errors.js';
import { createContext, type ApiDeps } from './context.js';
import { schema } from './schema/index.js';

/**
 * Expected errors keep their message and get a machine-readable code;
 * everything else is masked. Duck-typed rather than `instanceof GraphQLError`,
 * because graphql ships both CJS and ESM builds and the two classes differ.
 */
function maskError(error: unknown, message: string): Error {
  const original = error instanceof Error && 'originalError' in error ? error.originalError : error;
  if (original instanceof DomainError) {
    return createGraphQLError(original.message, { extensions: { code: original.code } });
  }
  if (error instanceof Error && 'locations' in error && !original) return error; // validation and parse errors
  return createGraphQLError(message, { extensions: { code: 'INTERNAL' } });
}

export function createApi(deps: ApiDeps) {
  return createYoga({
    schema,
    context: () => createContext(deps),
    graphqlEndpoint: '/graphql',
    maskedErrors: { maskError },
    logging: 'warn',
  });
}

export function listen(deps: ApiDeps, port: number): Promise<Server> {
  const server = createServer(createApi(deps));
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
