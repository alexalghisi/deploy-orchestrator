import { Client, Connection } from '@temporalio/client';
import { laneWorkflow } from '../workflows/lane.js';
import { cancelDeploymentSignal, enqueueSignal } from '../workflows/signals.js';
import { laneWorkflowId, type LaneJob } from '../workflows/types.js';

/** How the API hands work to the orchestrator. Tests substitute a recording fake. */
export interface DeploymentScheduler {
  enqueue(job: LaneJob): Promise<void>;
  cancel(target: { serviceId: string; environmentId: string; deploymentId: string }, reason: string): Promise<void>;
}

export class TemporalScheduler implements DeploymentScheduler {
  private constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
  ) {}

  static async connect(address: string, namespace: string, taskQueue: string): Promise<TemporalScheduler> {
    const connection = await Connection.connect({ address });
    return new TemporalScheduler(new Client({ connection, namespace }), taskQueue);
  }

  async enqueue(job: LaneJob): Promise<void> {
    const { serviceId, environmentId } = job.input;
    // starts the lane if it is idle, signals it if it is running: never two lanes for one target
    await this.client.workflow.signalWithStart(laneWorkflow, {
      taskQueue: this.taskQueue,
      workflowId: laneWorkflowId(serviceId, environmentId),
      args: [{ serviceId, environmentId }],
      signal: enqueueSignal,
      signalArgs: [job],
    });
  }

  async cancel(target: { serviceId: string; environmentId: string; deploymentId: string }, reason: string): Promise<void> {
    await this.client.workflow.signalWithStart(laneWorkflow, {
      taskQueue: this.taskQueue,
      workflowId: laneWorkflowId(target.serviceId, target.environmentId),
      args: [{ serviceId: target.serviceId, environmentId: target.environmentId }],
      signal: cancelDeploymentSignal,
      signalArgs: [{ deploymentId: target.deploymentId, reason }],
    });
  }

  async close(): Promise<void> {
    await this.client.connection.close();
  }
}
