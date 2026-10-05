import { useCallback } from 'react';
import { useMutation, type CombinedError } from 'urql';
import { useToast } from '../components/Toasts';
import { CancelDeploymentMutation, DeployServiceMutation, RollbackMutation } from '../graphql/operations';
import type { Deployment } from '../graphql/types';

export function errorMessage(error: CombinedError): string {
  return error.graphQLErrors[0]?.message ?? (error.networkError ? 'Could not reach the API' : 'Request failed');
}

/**
 * Deploy, cancel and rollback. The cache applies each optimistically and
 * rolls it back on error; this hook only has to tell the user why.
 */
export function useDeploymentActions() {
  const toast = useToast();
  const [deployState, deployMutation] = useMutation(DeployServiceMutation);
  const [cancelState, cancelMutation] = useMutation(CancelDeploymentMutation);
  const [rollbackState, rollbackMutation] = useMutation(RollbackMutation);

  const deploy = useCallback(
    async (serviceId: string, environmentId: string): Promise<Deployment | null> => {
      const result = await deployMutation({ serviceId, environmentId });
      if (result.error) toast.error(`Deploy failed: ${errorMessage(result.error)}`);
      return result.data?.deployService ?? null;
    },
    [deployMutation, toast],
  );

  const cancel = useCallback(
    async (id: string): Promise<boolean> => {
      const result = await cancelMutation({ id });
      if (result.error) toast.error(`Cancel failed: ${errorMessage(result.error)}`);
      return !result.error;
    },
    [cancelMutation, toast],
  );

  const rollback = useCallback(
    async (to: string): Promise<Deployment | null> => {
      const result = await rollbackMutation({ to });
      if (result.error) toast.error(`Rollback failed: ${errorMessage(result.error)}`);
      return result.data?.rollback ?? null;
    },
    [rollbackMutation, toast],
  );

  return {
    deploy,
    cancel,
    rollback,
    deploying: deployState.fetching,
    cancelling: cancelState.fetching,
    rollingBack: rollbackState.fetching,
  };
}
