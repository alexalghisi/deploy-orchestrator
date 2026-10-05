import { gql } from '@urql/core';
import type {
  CanvasService,
  Deployment,
  DeploymentWithEvents,
  FaultKind,
  FaultTarget,
  LogLine,
  Project,
  Service,
} from './types';

// Every query that returns a Deployment selects the same fields, so the
// normalized cache can always serve one from another.
export const DeploymentFields = gql`
  fragment DeploymentFields on Deployment {
    id
    status
    commitSha
    commitMessage
    image
    failureReason
    isRollback
    cancelRequested
    canCancel
    canRollback
    createdAt
    finishedAt
    service {
      id
    }
    environment {
      id
    }
  }
`;

export const ProjectsQuery = gql<{ projects: Project[] }>`
  query Projects {
    projects {
      id
      name
      environments {
        id
        name
      }
    }
  }
`;

export const CanvasQuery = gql<
  { project: { __typename: 'Project'; id: string; services: CanvasService[] } | null },
  { projectId: string; environmentId: string }
>`
  query Canvas($projectId: ID!, $environmentId: ID!) {
    project(id: $projectId) {
      id
      services {
        id
        name
        repo
        latestDeployment(environmentId: $environmentId) {
          ...DeploymentFields
        }
      }
    }
  }
  ${DeploymentFields}
`;

export const DEPLOYMENTS_PAGE_SIZE = 15;

export const ServiceDeploymentsQuery = gql<
  {
    service:
      | (Service & {
          deployments: { __typename: 'DeploymentConnection'; nodes: Deployment[]; endCursor: string | null; hasNextPage: boolean };
        })
      | null;
  },
  { serviceId: string; environmentId: string; first: number }
>`
  query ServiceDeployments($serviceId: ID!, $environmentId: ID!, $first: Int!) {
    service(id: $serviceId) {
      id
      name
      repo
      deployments(environmentId: $environmentId, first: $first) {
        nodes {
          ...DeploymentFields
        }
        endCursor
        hasNextPage
      }
    }
  }
  ${DeploymentFields}
`;

export const DeploymentQuery = gql<{ deployment: DeploymentWithEvents | null }, { id: string }>`
  query Deployment($id: ID!) {
    deployment(id: $id) {
      ...DeploymentFields
      events {
        id
        from
        to
        at
      }
    }
  }
  ${DeploymentFields}
`;

export const DeployServiceMutation = gql<{ deployService: Deployment }, { serviceId: string; environmentId: string }>`
  mutation DeployService($serviceId: ID!, $environmentId: ID!) {
    deployService(serviceId: $serviceId, environmentId: $environmentId) {
      ...DeploymentFields
    }
  }
  ${DeploymentFields}
`;

export const CancelDeploymentMutation = gql<
  { cancelDeployment: { __typename: 'Deployment'; id: string; cancelRequested: boolean; canCancel: boolean } },
  { id: string }
>`
  mutation CancelDeployment($id: ID!) {
    cancelDeployment(id: $id) {
      id
      cancelRequested
      canCancel
    }
  }
`;

export const RollbackMutation = gql<{ rollback: Deployment }, { to: string }>`
  mutation Rollback($to: ID!) {
    rollback(to: $to) {
      ...DeploymentFields
    }
  }
  ${DeploymentFields}
`;

export const InjectFaultMutation = gql<{ injectFault: boolean }, { target: FaultTarget; kind: FaultKind; times: number }>`
  mutation InjectFault($target: FaultTarget!, $kind: FaultKind!, $times: Int!) {
    injectFault(target: $target, kind: $kind, times: $times)
  }
`;

export const DeploymentUpdatedSubscription = gql<
  { deploymentUpdated: DeploymentWithEvents },
  { projectId: string; environmentId: string }
>`
  subscription DeploymentUpdated($projectId: ID!, $environmentId: ID!) {
    deploymentUpdated(projectId: $projectId, environmentId: $environmentId) {
      ...DeploymentFields
      events {
        id
        from
        to
        at
      }
    }
  }
  ${DeploymentFields}
`;

export const DeploymentLogsSubscription = gql<
  { deploymentLogs: { cursor: string; lines: LogLine[] } },
  { deploymentId: string; after: string | null }
>`
  subscription DeploymentLogs($deploymentId: ID!, $after: String) {
    deploymentLogs(deploymentId: $deploymentId, after: $after) {
      cursor
      lines {
        seq
        ts
        stream
        level
        message
      }
    }
  }
`;

export const ALL_OPERATIONS = {
  ProjectsQuery,
  CanvasQuery,
  ServiceDeploymentsQuery,
  DeploymentQuery,
  DeployServiceMutation,
  CancelDeploymentMutation,
  RollbackMutation,
  InjectFaultMutation,
  DeploymentUpdatedSubscription,
  DeploymentLogsSubscription,
};
