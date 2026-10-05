import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { Activities } from './activities.js';

export interface WorkerOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  activities: Activities;
}

export async function createWorker(options: WorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect({ address: options.address });
  return Worker.create({
    connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
    activities: options.activities,
    // a cancel should reach a heartbeating activity within a second, not half a minute
    maxHeartbeatThrottleInterval: '1 second',
  });
}
