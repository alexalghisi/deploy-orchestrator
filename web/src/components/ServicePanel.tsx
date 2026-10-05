import { useState } from 'react';
import { useQuery } from 'urql';
import { DEPLOYMENTS_PAGE_SIZE, ServiceDeploymentsQuery } from '../graphql/operations';
import { isOptimisticId } from '../graphql/cache';
import { useDeploymentActions } from '../hooks/useDeploymentActions';
import { useNow } from '../hooks/useNow';
import { DeploymentDetail } from './DeploymentDetail';
import { DeploymentRow } from './DeploymentRow';

interface Props {
  serviceId: string;
  environmentId: string;
  onClose: () => void;
}

export function ServicePanel({ serviceId, environmentId, onClose }: Props) {
  const [{ data, fetching, error }] = useQuery({
    query: ServiceDeploymentsQuery,
    variables: { serviceId, environmentId, first: DEPLOYMENTS_PAGE_SIZE },
  });
  // null follows the newest deployment; clicking a row pins one
  const [pinned, setPinned] = useState<string | null>(null);
  const { deploy, deploying } = useDeploymentActions();
  const now = useNow();

  const service = data?.service;
  const deployments = service?.deployments.nodes ?? [];
  const selectedId = pinned ?? deployments.find((d) => !isOptimisticId(d.id))?.id ?? null;

  return (
    <aside className="panel" aria-label="Service">
      <header className="panel__header">
        <div>
          <h2>{service?.name ?? '…'}</h2>
          <span className="muted">{service?.repo}</span>
        </div>
        <div className="panel__buttons">
          <button
            type="button"
            className="btn btn--primary"
            disabled={deploying}
            onClick={async () => {
              setPinned(null);
              await deploy(serviceId, environmentId);
            }}
          >
            Deploy
          </button>
          <button type="button" className="btn btn--ghost" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
      </header>
      {error && !service && <div className="banner banner--error">Could not load deployments.</div>}
      {!fetching && deployments.length === 0 && <p className="muted panel__empty">No deployments in this environment yet.</p>}
      <ul className="deployments" aria-label="Deployments">
        {deployments.map((d) => (
          <DeploymentRow
            key={d.id}
            deployment={d}
            now={now}
            selected={d.id === selectedId}
            onSelect={setPinned}
            onRolledBack={() => setPinned(null)}
          />
        ))}
      </ul>
      {selectedId && <DeploymentDetail key={selectedId} deploymentId={selectedId} />}
    </aside>
  );
}
