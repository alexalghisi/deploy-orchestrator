import SchemaBuilder from '@pothos/core';
import type { Context } from './context.js';

export const builder = new SchemaBuilder<{
  Context: Context;
  Scalars: {
    DateTime: { Input: Date; Output: Date };
  };
  DefaultFieldNullability: false;
}>({
  defaultFieldNullability: false,
});

builder.scalarType('DateTime', {
  description: 'ISO-8601 timestamp',
  serialize: (value) => value.toISOString(),
  parseValue: (value) => {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError('DateTime must be an ISO-8601 string');
    return new Date(value);
  },
});

builder.queryType({});
builder.mutationType({});
builder.subscriptionType({});
