import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('labels each status and pulses only while in flight', () => {
    const { container, rerender } = render(<StatusBadge status="BUILDING" />);
    expect(screen.getByText('Building')).toBeInTheDocument();
    expect(container.querySelector('.badge__dot--pulse')).not.toBeNull();

    rerender(<StatusBadge status="ACTIVE" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(container.querySelector('.badge__dot--pulse')).toBeNull();
  });

  it('says Cancelling for an in-flight deployment with a pending cancel, but not for a finished one', () => {
    const { rerender } = render(<StatusBadge status="DEPLOYING" cancelRequested />);
    expect(screen.getByText('Cancelling')).toBeInTheDocument();
    rerender(<StatusBadge status="CANCELLED" cancelRequested />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });
});
