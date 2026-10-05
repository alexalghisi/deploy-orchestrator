import { randomBytes } from 'node:crypto';

const MESSAGES = [
  'Fix N+1 query on the orders endpoint',
  'Bump undici to 7.16',
  'Add retry around webhook delivery',
  'Cache feature flags for 30s',
  'Move session store to Redis',
  'Paginate the audit log',
  'Log request ids on 5xx',
  'Drop the legacy /v1/export route',
];

/** Stands in for "the head of the default branch" when a deploy names no commit. */
export function headCommit(): { sha: string; message: string } {
  const sha = randomBytes(20).toString('hex');
  const index = Number.parseInt(sha.slice(0, 4), 16) % MESSAGES.length;
  return { sha, message: MESSAGES[index]! };
}
