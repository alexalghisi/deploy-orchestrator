import { fireEvent, render, screen } from '@testing-library/react';
import type { LogLine } from '../graphql/types';
import { LogView } from './LogView';

function makeLines(count: number): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: String(i + 1),
    ts: '2026-10-05T10:00:00.000Z',
    stream: 'build',
    level: i % 100 === 99 ? 'warn' : 'info',
    message: `line ${i + 1}`,
  }));
}

const rows = (container: HTMLElement) => container.querySelectorAll('.logs__row');

describe('LogView', () => {
  it('renders only the visible window of a 50,000-line log', () => {
    const { container } = render(<LogView lines={makeLines(50_000)} version={1} fallbackHeight={400} />);
    expect(rows(container).length).toBeLessThan(45);
    expect(container.querySelector('.logs__spacer')).toHaveStyle({ height: `${50_000 * 20}px` });
  });

  it('follows the tail as lines arrive', () => {
    const lines = makeLines(100);
    const { container, rerender } = render(<LogView lines={lines} version={1} fallbackHeight={400} />);
    expect(screen.getByText('line 100')).toBeInTheDocument();

    lines.push(...makeLines(200).slice(100));
    rerender(<LogView lines={lines} version={2} fallbackHeight={400} />);
    expect(screen.getByText('line 200')).toBeInTheDocument();
    expect(screen.queryByText('line 1')).toBeNull();
    expect(rows(container).length).toBeLessThan(45);
  });

  it('stops following when scrolled up, and offers a way back', () => {
    const lines = makeLines(1_000);
    const { rerender } = render(<LogView lines={lines} version={1} fallbackHeight={400} />);
    const viewport = screen.getByRole('log');
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(screen.getByText('line 1')).toBeInTheDocument();

    lines.push(...makeLines(1_050).slice(1_000));
    rerender(<LogView lines={lines} version={2} fallbackHeight={400} />);
    expect(screen.getByText('line 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(screen.getByText('line 1050')).toBeInTheDocument();
  });

  it('shows a placeholder before the first line', () => {
    render(<LogView lines={[]} version={0} />);
    expect(screen.getByText('Waiting for output…')).toBeInTheDocument();
  });
});
