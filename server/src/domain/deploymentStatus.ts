export const DEPLOYMENT_STATUSES = [
  'QUEUED',
  'BUILDING',
  'DEPLOYING',
  'ACTIVE',
  'FAILED',
  'CANCELLED',
  'REMOVED',
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * The only definition of which status changes are legal. The migration seeds
 * `deployment_status_transitions` from the same pairs and a test keeps the two
 * in sync, so the database rejects anything this map would reject.
 *
 * QUEUED -> DEPLOYING exists for rollbacks: the image is already built.
 */
export const TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = {
  QUEUED: ['BUILDING', 'DEPLOYING', 'FAILED', 'CANCELLED'],
  BUILDING: ['DEPLOYING', 'FAILED', 'CANCELLED'],
  DEPLOYING: ['ACTIVE', 'FAILED', 'CANCELLED'],
  ACTIVE: ['REMOVED'],
  FAILED: [],
  CANCELLED: [],
  REMOVED: [],
};

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: DeploymentStatus,
    readonly to: DeploymentStatus,
  ) {
    super(`Deployment cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: DeploymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Still on its way to ACTIVE: it can be cancelled or superseded. */
export function isInFlight(status: DeploymentStatus): boolean {
  return status === 'QUEUED' || status === 'BUILDING' || status === 'DEPLOYING';
}

export function isDeploymentStatus(value: string): value is DeploymentStatus {
  return (DEPLOYMENT_STATUSES as readonly string[]).includes(value);
}

export function allTransitions(): Array<[DeploymentStatus, DeploymentStatus]> {
  return DEPLOYMENT_STATUSES.flatMap((from) => TRANSITIONS[from].map((to): [DeploymentStatus, DeploymentStatus] => [from, to]));
}
