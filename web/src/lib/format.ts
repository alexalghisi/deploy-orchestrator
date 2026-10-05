import type { DeploymentStatus } from '../graphql/types';

export function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function duration(fromIso: string, toIso: string): string {
  const ms = Math.max(0, Date.parse(toIso) - Date.parse(fromIso));
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const IN_FLIGHT: readonly DeploymentStatus[] = ['QUEUED', 'BUILDING', 'DEPLOYING'];
export const isInFlight = (status: DeploymentStatus): boolean => IN_FLIGHT.includes(status);

const LABELS: Record<DeploymentStatus, string> = {
  QUEUED: 'Queued',
  BUILDING: 'Building',
  DEPLOYING: 'Deploying',
  ACTIVE: 'Active',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REMOVED: 'Removed',
};

export function statusLabel(status: DeploymentStatus, cancelRequested = false): string {
  return cancelRequested && isInFlight(status) ? 'Cancelling' : LABELS[status];
}
