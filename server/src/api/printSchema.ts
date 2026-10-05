import { writeFile } from 'node:fs/promises';
import { printSchema } from 'graphql';
import { schema } from './schema/index.js';

export const SCHEMA_FILE = new URL('../../schema.graphql', import.meta.url);

export function printedSchema(): string {
  return `${printSchema(schema)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await writeFile(SCHEMA_FILE, printedSchema());
  console.log('wrote schema.graphql');
}
