import type { Deployment } from '../graphql/types';
import { isOptimisticId } from '../graphql/cache';
import { useDeploymentActions } from '../hooks/useDeploymentActions';

interface Props {
  deployment: Deployment;
  onRolledBack?: (deployment: Deployment) => void;
}

/** Shows only what the server says is allowed (canCancel, canRollback). */
export function DeploymentActions({ deployment, onRolledBack }: Props) {
  const { cancel, rollback } = useDeploymentActions();
  if (isOptimisticId(deployment.id)) return null;

  return (
    <div className="actions">
      {deployment.canCancel && (
        <button type="button" className="btn btn--ghost btn--danger" onClick={() => void cancel(deployment.id)}>
          Cancel
        </button>
      )}
      {deployment.canRollback && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={async () => {
            const created = await rollback(deployment.id);
            if (created) onRolledBack?.(created);
          }}
        >
          Rollback
        </button>
      )}
    </div>
  );
}
