export interface GqlResult<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/** The one thing tests need from the server: its in-process fetch. */
interface Yoga {
  fetch(url: string, init: RequestInit): Promise<Response> | Response;
}

export async function gql<T>(yoga: Yoga, query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> {
  const res = await yoga.fetch('http://test/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as GqlResult<T>;
}

/** Opens a subscription over SSE and yields each `next` payload. */
export async function* subscribe<T>(
  yoga: Yoga,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<GqlResult<T>> {
  const res = await yoga.fetch('http://test/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.body) throw new Error('no body');
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (data) yield JSON.parse(data) as GqlResult<T>;
    }
  }
}

/** The next payload's data, failing loudly on errors or a closed stream. */
export async function nextData<T>(stream: AsyncGenerator<GqlResult<T>>): Promise<T> {
  const next = await stream.next();
  if (next.done || !next.value.data) throw new Error(`no data: ${JSON.stringify(next.value)}`);
  return next.value.data;
}
