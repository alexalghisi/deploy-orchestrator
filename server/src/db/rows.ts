import { isDeploymentStatus, type DeploymentStatus } from '../domain/deploymentStatus.js';
import type { Deployment, DeploymentEvent, Environment, Project, Service } from '../domain/types.js';

export interface DeploymentRow {
  id: string;
  project_id: string;
  service_id: string;
  environment_id: string;
  status: string;
  commit_sha: string;
  commit_message: string;
  image: string | null;
  rollback_of: string | null;
  failure_reason: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

function status(value: string): DeploymentStatus {
  if (!isDeploymentStatus(value)) throw new Error(`Unknown deployment status ${value}`);
  return value;
}

export function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    projectId: row.project_id,
    serviceId: row.service_id,
    environmentId: row.environment_id,
    status: status(row.status),
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    image: row.image,
    rollbackOf: row.rollback_of,
    failureReason: row.failure_reason,
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export interface ProjectRow {
  id: string;
  name: string;
  created_at: Date;
}

export const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, createdAt: r.created_at });

export interface EnvironmentRow {
  id: string;
  project_id: string;
  name: string;
}

export const toEnvironment = (r: EnvironmentRow): Environment => ({ id: r.id, projectId: r.project_id, name: r.name });

export interface ServiceRow {
  id: string;
  project_id: string;
  name: string;
  repo: string;
}

export const toService = (r: ServiceRow): Service => ({ id: r.id, projectId: r.project_id, name: r.name, repo: r.repo });

export interface DeploymentEventRow {
  id: string;
  deployment_id: string;
  from_status: string | null;
  to_status: string;
  at: Date;
}

export const toDeploymentEvent = (r: DeploymentEventRow): DeploymentEvent => ({
  id: r.id,
  deploymentId: r.deployment_id,
  from: r.from_status === null ? null : status(r.from_status),
  to: status(r.to_status),
  at: r.at,
});
