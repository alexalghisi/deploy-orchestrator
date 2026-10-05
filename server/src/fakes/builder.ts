import { createHash } from 'node:crypto';
import { FatalError, TransientError, type FaultInjector } from './faults.js';
import { hang, type Clock } from './timing.js';

export type Emit = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface BuildRequest {
  deploymentId: string;
  repo: string;
  commitSha: string;
}

interface Step {
  ms: number;
  lines: string[];
}

function steps(req: BuildRequest): Step[] {
  const name = req.repo.split('/').at(-1) ?? 'app';
  return [
    { ms: 300, lines: [`Cloning ${req.repo} at ${req.commitSha.slice(0, 7)}`, 'Detected Node.js 22 (package-lock.json)'] },
    { ms: 600, lines: ['#1 [internal] load build definition', '#2 FROM node:22-alpine', '#3 COPY package.json package-lock.json ./'] },
    {
      ms: 1200,
      lines: [
        '#4 RUN npm ci',
        'npm warn deprecated inflight@1.0.6: This module is not supported',
        'added 812 packages, and audited 813 packages in 9s',
        'found 0 vulnerabilities',
      ],
    },
    { ms: 900, lines: ['#5 COPY . .', '#6 RUN npm run build', `> ${name}@1.0.0 build`, '> tsc -p tsconfig.build.json'] },
    { ms: 400, lines: ['#7 exporting layers', '#7 writing image sha256 manifest', 'Build finished'] },
  ];
}

/**
 * Stand-in for a build service. Produces the kind of output a Docker build
 * does, with realistic pauses, and the image name is derived from the commit
 * so retries produce the same artifact.
 */
export class FakeBuilder {
  constructor(
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
  ) {}

  async build(req: BuildRequest, emit: Emit, signal: AbortSignal, onProgress: () => void): Promise<{ image: string }> {
    const fault = this.faults.take('build');
    const plan = steps(req);
    for (const [index, step] of plan.entries()) {
      for (const line of step.lines) {
        emit('info', line);
        await this.clock.wait(step.ms / step.lines.length, signal);
      }
      onProgress();
      if (index === 2 && fault === 'transient') {
        emit('error', 'npm error network request to https://registry.npmjs.org/typescript failed, reason: ETIMEDOUT');
        throw new TransientError('npm registry timed out');
      }
      if (index === 3 && fault === 'fatal') {
        emit('error', "src/server.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.");
        throw new FatalError('TypeScript compilation failed');
      }
      if (index === 3 && fault === 'hang') {
        emit('warn', 'Build step is taking longer than usual');
        await hang(signal);
      }
    }
    const digest = createHash('sha256').update(`${req.repo}@${req.commitSha}`).digest('hex').slice(0, 12);
    return { image: `registry.local/${req.repo.split('/').at(-1) ?? 'app'}:${req.commitSha.slice(0, 7)}-${digest}` };
  }

  async push(image: string, emit: Emit, signal: AbortSignal): Promise<void> {
    const fault = this.faults.take('push');
    emit('info', `Pushing ${image}`);
    await this.clock.wait(400, signal);
    if (fault === 'transient') {
      emit('warn', 'registry returned 502 Bad Gateway');
      throw new TransientError('registry unavailable');
    }
    if (fault === 'hang') await hang(signal);
    emit('info', 'Pushed 7 layers (3 already present)');
  }
}
