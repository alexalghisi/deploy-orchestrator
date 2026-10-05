import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { deployment, withEvents } from '../test/factories';
import { createFakeClient, deferred, withClient, type FakeResponse } from '../test/fakeServer';
import type { Deployment } from '../graphql/types';
import { ServicePanel } from './ServicePanel';

function setup(initial: Deployment[], handlers: Record<string, (v: Record<string, unknown>) => FakeResponse | Promise<FakeResponse>>) {
  const byId = new Map(initial.map((d) => [d.id, d]));
  const client = createFakeClient({
    ServiceDeployments: () => ({
      data: {
        service: {
          __typename: 'Service',
          id: 'svc-1',
          name: 'api',
          repo: 'github.com/acme/api',
          deployments: { __typename: 'DeploymentConnection', nodes: initial, endCursor: null, hasNextPage: false },
        },
      },
    }),
    Deployment: (v) => {
      const d = byId.get(String(v.id));
      return { data: { deployment: d ? withEvents(d) : null } };
    },
    ...handlers,
  });
  render(withClient(client, <ServicePanel serviceId="svc-1" environmentId="env-1" onClose={() => {}} />));
}

const list = () => screen.getByRole('list', { name: 'Deployments' });
const rowTexts = () => within(list()).getAllByRole('listitem').map((li) => li.textContent ?? '');

describe('ServicePanel', () => {
  it('shows a deploy immediately, before the server answers, then replaces it with the real one', async () => {
    const live = deployment({ commitMessage: 'Initial release' });
    const response = deferred<FakeResponse>();
    setup([live], { DeployService: () => response.promise });
    await screen.findByText('Initial release');

    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(rowTexts()[0]).toContain('Queuing…');
    expect(rowTexts()).toHaveLength(2);

    response.resolve({ data: { deployService: deployment({ status: 'QUEUED', commitMessage: 'Fix N+1 query', canCancel: true }) } });
    await waitFor(() => expect(rowTexts()[0]).toContain('Fix N+1 query'));
    expect(rowTexts()).toHaveLength(2);
    expect(within(list()).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('rolls the optimistic deploy back and explains why when the server refuses', async () => {
    const live = deployment({ commitMessage: 'Initial release' });
    setup([live], {
      DeployService: () => ({
        errors: [{ message: 'Deployment could not be scheduled: connect ECONNREFUSED', extensions: { code: 'SCHEDULING_FAILED' } }],
      }),
    });
    await screen.findByText('Initial release');

    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Deploy failed: Deployment could not be scheduled');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.queryByText('Queuing…')).toBeNull();
  });

  it('shows Cancelling at once and reverts if the cancel is rejected', async () => {
    const building = deployment({ status: 'BUILDING', canCancel: true, commitMessage: 'Slow build' });
    const response = deferred<FakeResponse>();
    setup([building], { CancelDeployment: () => response.promise });
    await screen.findAllByText('Slow build');

    await userEvent.click(within(list()).getByRole('button', { name: 'Cancel' }));
    expect(within(list()).getByText('Cancelling')).toBeInTheDocument();
    expect(within(list()).queryByRole('button', { name: 'Cancel' })).toBeNull();

    response.resolve({ errors: [{ message: 'A ACTIVE deployment cannot be cancelled', extensions: { code: 'NOT_CANCELLABLE' } }] });
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancel failed: A ACTIVE deployment cannot be cancelled');
    expect(within(list()).getByText('Building')).toBeInTheDocument();
  });

  it('offers rollback only where the server allows it, and adds the rollback on top', async () => {
    const current = deployment({ status: 'ACTIVE', commitMessage: 'Current' });
    const previous = deployment({ status: 'REMOVED', canRollback: true, commitMessage: 'Previous', commitSha: 'bbbbbbb' });
    setup([current, previous], {
      Rollback: (v) => ({
        data: {
          rollback: deployment({ status: 'QUEUED', isRollback: true, commitSha: 'bbbbbbb', commitMessage: `Rollback to bbbbbbb (${String(v.to).slice(-2)})` }),
        },
      }),
    });
    await screen.findAllByText('Current');

    const buttons = within(list()).getAllByRole('button', { name: 'Rollback' });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(rowTexts()[0]).toMatch(/rollbackRollback to bbbbbbb/));
    expect(rowTexts()).toHaveLength(3);
  });
});
