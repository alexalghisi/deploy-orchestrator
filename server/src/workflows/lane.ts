import {
  ParentClosePolicy,
  condition,
  continueAsNew,
  log,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
  type ChildWorkflowHandle,
} from '@temporalio/workflow';
import type { Activities } from './activities.js';
import { deployWorkflow } from './deploy.js';
import { rollbackWorkflow } from './rollback.js';
import { cancelDeploymentSignal, cancelSignal, enqueueSignal } from './signals.js';
import { deploymentWorkflowId, type CancelledJob, type LaneInput, type LaneJob } from './types.js';

const { cancelQueued } = proxyActivities<Activities>({
  startToCloseTimeout: '15 seconds',
  retry: { initialInterval: '200 milliseconds', maximumInterval: '10 seconds' },
});

const IDLE_TIMEOUT = '10 minutes';

type PipelineWorkflow = typeof deployWorkflow | typeof rollbackWorkflow;

interface Running {
  job: LaneJob;
  handle?: ChildWorkflowHandle<PipelineWorkflow>;
  cancelReason?: string;
}

/**
 * One lane per service and environment, with a deterministic workflow id, so
 * Temporal itself guarantees a single writer. It runs one deployment at a
 * time; the newest request wins: queued requests are dropped and a running
 * one is cancelled (with compensation) when something newer arrives.
 */
export async function laneWorkflow(input: LaneInput): Promise<void> {
  const queue: LaneJob[] = [...(input.queue ?? [])];
  const drops: CancelledJob[] = [...(input.drops ?? [])];
  let running: Running | null = null;

  const requestCancel = async (target: Running, reason: string): Promise<void> => {
    if (target.cancelReason) return;
    target.cancelReason = reason;
    if (target.handle) await sendCancel(target.handle, reason);
  };

  setHandler(enqueueSignal, async (job) => {
    const supersededBy = `Superseded by deployment ${job.input.deploymentId.slice(0, 8)}`;
    for (const older of queue.splice(0)) drops.push({ deploymentId: older.input.deploymentId, reason: supersededBy });
    queue.push(job);
    if (running) await requestCancel(running, supersededBy);
  });

  setHandler(cancelDeploymentSignal, async ({ deploymentId, reason }) => {
    const index = queue.findIndex((j) => j.input.deploymentId === deploymentId);
    if (index >= 0) {
      queue.splice(index, 1);
      drops.push({ deploymentId, reason });
    } else if (running?.job.input.deploymentId === deploymentId) {
      await requestCancel(running, reason);
    } else {
      // not ours (any more): cancelQueued leaves anything that is not QUEUED alone
      drops.push({ deploymentId, reason });
    }
  });

  for (;;) {
    const hasWork = await condition(() => queue.length > 0 || drops.length > 0, IDLE_TIMEOUT);
    if (!hasWork) return;

    while (drops.length > 0) {
      const drop = drops.shift()!;
      await cancelQueued(drop.deploymentId, drop.reason);
    }

    const job = queue.shift();
    if (!job) continue;
    const current: Running = { job };
    running = current;
    try {
      current.handle = await startJob(job);
      // a cancel that arrived while the child was starting
      if (current.cancelReason) await sendCancel(current.handle, current.cancelReason);
      await current.handle.result();
    } catch (err) {
      log.error('deployment workflow failed unexpectedly', { deploymentId: job.input.deploymentId, error: String(err) });
    } finally {
      running = null;
    }

    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof laneWorkflow>({ ...input, queue, drops });
    }
  }
}

function startJob(job: LaneJob): Promise<ChildWorkflowHandle<PipelineWorkflow>> {
  const options = {
    workflowId: deploymentWorkflowId(job.input.deploymentId),
    // the lane is the only thing waiting on a deployment; if it goes, so do they
    parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
  };
  return job.kind === 'deploy'
    ? startChild(deployWorkflow, { ...options, args: [job.input] })
    : startChild(rollbackWorkflow, { ...options, args: [job.input] });
}

/**
 * The child may already have finished: it can go ACTIVE and complete in the
 * same moment a newer deploy arrives, before the lane has seen the result.
 * Signalling a closed workflow fails, and an error escaping a signal handler
 * would fail the lane's workflow task over and over, so it is swallowed here.
 */
async function sendCancel(handle: ChildWorkflowHandle<PipelineWorkflow>, reason: string): Promise<void> {
  try {
    await handle.signal(cancelSignal, { reason });
  } catch (err) {
    log.info('deployment finished before it could be cancelled', { workflowId: handle.workflowId, error: String(err) });
  }
}
