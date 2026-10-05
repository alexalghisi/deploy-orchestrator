import { useMutation } from 'urql';
import { InjectFaultMutation } from '../graphql/operations';
import type { FaultKind, FaultTarget } from '../graphql/types';
import { errorMessage } from '../hooks/useDeploymentActions';
import { useToast } from './Toasts';

const SCENARIOS: Array<{ label: string; target: FaultTarget; kind: FaultKind; times: number }> = [
  { label: 'Flaky npm registry (build fails once, then retries)', target: 'build', kind: 'transient', times: 1 },
  { label: 'Compile error (build fails, no retry)', target: 'build', kind: 'fatal', times: 1 },
  { label: 'Registry down (push fails every attempt)', target: 'push', kind: 'transient', times: 5 },
  { label: 'App crashes on boot (health check fails)', target: 'provision', kind: 'fatal', times: 1 },
  { label: 'Slow build (hangs until cancelled)', target: 'build', kind: 'hang', times: 1 },
];

/** Demo control: arms a fault in the fake services for the next deploy. */
export function SimulateMenu() {
  const [, inject] = useMutation(InjectFaultMutation);
  const toast = useToast();

  return (
    <label className="simulate">
      <span className="muted">Simulate</span>
      <select
        aria-label="Simulate a failure on the next deploy"
        value=""
        onChange={async (event) => {
          const scenario = SCENARIOS[Number(event.target.value)];
          if (!scenario) return;
          const result = await inject({ target: scenario.target, kind: scenario.kind, times: scenario.times });
          if (result.error) toast.error(errorMessage(result.error));
          else toast.info(`Armed: ${scenario.label}`);
        }}
      >
        <option value="">Next deploy behaves</option>
        {SCENARIOS.map((s, i) => (
          <option key={s.label} value={i}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
