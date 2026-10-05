export const DEPLOYMENT_STATUSES = ['QUEUED', 'BUILDING', 'DEPLOYING', 'ACTIVE', 'FAILED', 'CANCELLED', 'REMOVED'] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export interface Ref<T extends string> {
  __typename: T;
  id: string;
}

export interface Deployment {
  __typename: 'Deployment';
  id: string;
  status: DeploymentStatus;
  commitSha: string;
  commitMessage: string;
  image: string | null;
  failureReason: string | null;
  isRollback: boolean;
  cancelRequested: boolean;
  canCancel: boolean;
  canRollback: boolean;
  createdAt: string;
  finishedAt: string | null;
  service: Ref<'Service'>;
  environment: Ref<'Environment'>;
}

export interface DeploymentEvent {
  __typename: 'DeploymentEvent';
  id: string;
  from: DeploymentStatus | null;
  to: DeploymentStatus;
  at: string;
}

export interface DeploymentWithEvents extends Deployment {
  events: DeploymentEvent[];
}

export interface Environment {
  __typename: 'Environment';
  id: string;
  name: string;
}

export interface Service {
  __typename: 'Service';
  id: string;
  name: string;
  repo: string;
}

export interface CanvasService extends Service {
  latestDeployment: Deployment | null;
}

export interface Project {
  __typename: 'Project';
  id: string;
  name: string;
  environments: Environment[];
}

export interface LogLine {
  seq: string;
  ts: string;
  stream: 'build' | 'deploy';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type FaultTarget = 'build' | 'push' | 'provision' | 'healthcheck';
export type FaultKind = 'transient' | 'fatal' | 'hang';
