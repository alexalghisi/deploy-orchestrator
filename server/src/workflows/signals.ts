import { defineSignal } from '@temporalio/workflow';
import type { CancelRequest, LaneJob } from './types.js';

/** Sent to a running deploy or rollback workflow. */
export const cancelSignal = defineSignal<[CancelRequest]>('cancel');

/** Sent to a lane: a new deployment for its service and environment. */
export const enqueueSignal = defineSignal<[LaneJob]>('enqueue');

/** Sent to a lane: cancel a deployment, wherever it is in the lane. */
export const cancelDeploymentSignal = defineSignal<[{ deploymentId: string; reason: string }]>('cancelDeployment');
