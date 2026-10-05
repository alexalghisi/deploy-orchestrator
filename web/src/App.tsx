import { useState } from 'react';
import { useQuery, useSubscription } from 'urql';
import { CanvasQuery, DeploymentUpdatedSubscription, ProjectsQuery } from './graphql/operations';
import type { Project } from './graphql/types';
import { useNow } from './hooks/useNow';
import { ServiceCard } from './components/ServiceCard';
import { ServicePanel } from './components/ServicePanel';
import { SimulateMenu } from './components/SimulateMenu';

export function App() {
  const [{ data, error }] = useQuery({ query: ProjectsQuery });
  const project = data?.projects[0];

  if (error) return <div className="fullscreen">Could not reach the API. Is the server running?</div>;
  if (!project) return <div className="fullscreen muted">Loading…</div>;
  return <ProjectView project={project} />;
}

function ProjectView({ project }: { project: Project }) {
  const [environmentId, setEnvironmentId] = useState(project.environments[0]?.id ?? '');
  const [openService, setOpenService] = useState<string | null>(null);
  const now = useNow();

  // one stream per project environment feeds the normalized cache; every view updates from it
  useSubscription({ query: DeploymentUpdatedSubscription, variables: { projectId: project.id, environmentId } });
  const [{ data }] = useQuery({ query: CanvasQuery, variables: { projectId: project.id, environmentId } });
  const services = data?.project?.services ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__project">
          <span className="logo" aria-hidden="true" />
          <strong>{project.name}</strong>
        </div>
        <nav className="envs" aria-label="Environments">
          {project.environments.map((env) => (
            <button
              key={env.id}
              type="button"
              className={env.id === environmentId ? 'env env--active' : 'env'}
              aria-pressed={env.id === environmentId}
              onClick={() => setEnvironmentId(env.id)}
            >
              {env.name}
            </button>
          ))}
        </nav>
        <SimulateMenu />
      </header>
      <main className={openService ? 'workspace workspace--with-panel' : 'workspace'}>
        <section className="canvas" aria-label="Services">
          {services.map((service) => (
            <ServiceCard key={service.id} service={service} now={now} selected={service.id === openService} onOpen={setOpenService} />
          ))}
        </section>
        {openService && (
          <ServicePanel key={`${openService}:${environmentId}`} serviceId={openService} environmentId={environmentId} onClose={() => setOpenService(null)} />
        )}
      </main>
    </div>
  );
}
