// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchema, validate, type DocumentNode } from 'graphql';
import { ALL_OPERATIONS } from './operations';

// The server commits its printed schema and a server test keeps it current,
// so this catches a dashboard query drifting from the API at test time.
const schema = buildSchema(readFileSync(resolve(__dirname, '../../../server/schema.graphql'), 'utf8'));

describe('dashboard operations', () => {
  it.each(Object.entries(ALL_OPERATIONS))('%s is valid against the server schema', (_, document) => {
    expect(validate(schema, document as unknown as DocumentNode).map((e) => e.message)).toEqual([]);
  });
});
