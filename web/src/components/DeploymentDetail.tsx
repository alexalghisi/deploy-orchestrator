import { useQuery } from 'urql';
import { DeploymentQuery } from '../graphql/operations';
import { useLogStream } from '../hooks/useLogStream';
import { duration, shortSha } from '../lib/format';
import { LogView } from './LogView';
import { StatusBadge } from './StatusBadge';

export function DeploymentDetail({ deploymentId }: { deploymentId: string }) {
  const [{ data, error }] = useQuery({ query: DeploymentQuery, variables: { id: deploymentId }, requestPolicy: 'cache-and-network' });
  const logs = useLogStream(deploymentId);
  const deployment = data?.deployment;

  if (error && !deployment) return <div className="detail detail--error">Could not load the deployment.</div>;
  if (!deployment) return <div className="detail detail--loading">Loading…</div>;

  const start = deployment.events[0]?.at ?? deployment.createdAt;
  return (
    <section className="detail" aria-label="Deployment detail">
      <header className="detail__header">
        <StatusBadge status={deployment.status} cancelRequested={deployment.cancelRequested} />
        <div className="detail__title">
          <span>{deployment.commitMessage || 'Deployment'}</span>
          <code>{shortSha(deployment.commitSha)}</code>
        </div>
      </header>
      {deployment.failureReason && (
        <p className="detail__failure" role="alert">
          {deployment.failureReason}
        </p>
      )}
      <ol className="timeline" aria-label="Status history">
        {deployment.events.map((event) => (
          <li key={event.id} className={`timeline__step timeline__step--${event.to.toLowerCase()}`}>
            <span>{event.to.toLowerCase()}</span>
            <span className="timeline__at">+{duration(start, event.at)}</span>
          </li>
        ))}
      </ol>
      {logs.error && (
        <div className="banner banner--error" role="alert">
          {logs.error}
          <button type="button" className="btn btn--ghost" onClick={logs.retry}>
            Reconnect
          </button>
        </div>
      )}
      <LogView lines={logs.lines} version={logs.version} />
    </section>
  );
}
