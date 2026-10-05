import type { DeploymentStatus } from './deploymentStatus.js';

export interface Project {
  id: string;
  name: string;
  createdAt: Date;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
}

export interface Service {
  id: string;
  projectId: string;
  name: string;
  repo: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  serviceId: string;
  environmentId: string;
  status: DeploymentStatus;
  commitSha: string;
  commitMessage: string;
  image: string | null;
  rollbackOf: string | null;
  failureReason: string | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface DeploymentEvent {
  id: string;
  deploymentId: string;
  from: DeploymentStatus | null;
  to: DeploymentStatus;
  at: Date;
}

/** Thrown for lookups by id that find nothing; the API maps it to NOT_FOUND. */
export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}
