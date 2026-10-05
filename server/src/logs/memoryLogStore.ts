import type { LogLine, LogPage, LogStore } from '../domain/logs.js';

/** Same contract as the ClickHouse store; used by workflow and API tests. */
export class MemoryLogStore implements LogStore {
  private readonly byDeployment = new Map<string, LogLine[]>();

  async append(lines: readonly LogLine[]): Promise<void> {
    for (const line of lines) {
      const list = this.byDeployment.get(line.deploymentId) ?? [];
      list.push(line);
      this.byDeployment.set(line.deploymentId, list);
    }
  }

  async page(deploymentId: string, options: { after?: string | null; limit: number }): Promise<LogPage> {
    const after = BigInt(options.after ?? '0');
    const lines = (this.byDeployment.get(deploymentId) ?? [])
      .filter((l) => BigInt(l.seq) > after)
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
      .slice(0, options.limit);
    return { lines, endCursor: lines.at(-1)?.seq ?? null };
  }

  messages(deploymentId: string): string[] {
    return (this.byDeployment.get(deploymentId) ?? []).map((l) => l.message);
  }
}
