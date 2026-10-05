import type { CanvasService } from '../graphql/types';
import { shortSha, timeAgo } from '../lib/format';
import { StatusBadge } from './StatusBadge';

interface Props {
  service: CanvasService;
  selected: boolean;
  now: number;
  onOpen: (id: string) => void;
}

export function ServiceCard({ service, selected, now, onOpen }: Props) {
  const latest = service.latestDeployment;
  return (
    <button
      type="button"
      className={selected ? 'card card--selected' : 'card'}
      onClick={() => onOpen(service.id)}
      aria-label={`Open ${service.name}`}
      data-status={latest?.status ?? 'NONE'}
    >
      <span className="card__head">
        <span className="card__icon" aria-hidden="true">
          {service.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="card__name">{service.name}</span>
      </span>
      <span className="card__repo">{service.repo}</span>
      {latest ? (
        <span className="card__latest">
          <StatusBadge status={latest.status} cancelRequested={latest.cancelRequested} />
          <span className="card__commit">{latest.commitMessage}</span>
          <span className="card__meta">
            {latest.commitSha && <code>{shortSha(latest.commitSha)}</code>} {timeAgo(latest.createdAt, now)}
          </span>
        </span>
      ) : (
        <span className="card__latest muted">Not deployed</span>
      )}
    </button>
  );
}
