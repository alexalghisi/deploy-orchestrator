import type { DeploymentStatus } from '../graphql/types';
import { isInFlight, statusLabel } from '../lib/format';

export function StatusBadge({ status, cancelRequested = false }: { status: DeploymentStatus; cancelRequested?: boolean }) {
  const live = isInFlight(status);
  return (
    <span className={`badge badge--${status.toLowerCase()}`} data-status={status}>
      <span className={live ? 'badge__dot badge__dot--pulse' : 'badge__dot'} aria-hidden="true" />
      {statusLabel(status, cancelRequested)}
    </span>
  );
}
