import type { Deployment } from '../graphql/types';
import { shortSha, timeAgo } from '../lib/format';
import { DeploymentActions } from './DeploymentActions';
import { StatusBadge } from './StatusBadge';

interface Props {
  deployment: Deployment;
  selected: boolean;
  now: number;
  onSelect: (id: string) => void;
  onRolledBack: (deployment: Deployment) => void;
}

export function DeploymentRow({ deployment, selected, now, onSelect, onRolledBack }: Props) {
  return (
    <li className={selected ? 'deployment deployment--selected' : 'deployment'}>
      <button type="button" className="deployment__main" onClick={() => onSelect(deployment.id)} aria-pressed={selected}>
        <StatusBadge status={deployment.status} cancelRequested={deployment.cancelRequested} />
        <span className="deployment__commit">
          <span className="deployment__message">
            {deployment.isRollback && <span className="tag">rollback</span>}
            {deployment.commitMessage || 'No commit message'}
          </span>
          <span className="deployment__meta">
            {deployment.commitSha && <code>{shortSha(deployment.commitSha)}</code>}
            <span>{timeAgo(deployment.createdAt, now)}</span>
          </span>
        </span>
      </button>
      <DeploymentActions deployment={deployment} onRolledBack={onRolledBack} />
    </li>
  );
}
