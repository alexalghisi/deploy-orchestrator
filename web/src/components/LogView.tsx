import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { LogLine } from '../graphql/types';

interface LogViewProps {
  lines: readonly LogLine[];
  /** Changes whenever `lines` grows (it may be appended in place). */
  version: number;
  rowHeight?: number;
  overscan?: number;
  /** Used until the container has been measured (and in tests, where nothing is). */
  fallbackHeight?: number;
}

const timeOf = (iso: string) => iso.slice(11, 23);

/**
 * Fixed-height rows, absolutely positioned inside a spacer as tall as the
 * whole log: the DOM holds only the visible rows, whether the log has 50 lines
 * or 50,000. It sticks to the bottom while you are at the bottom and stops
 * following as soon as you scroll up.
 */
export function LogView({ lines, version, rowHeight = 20, overscan = 10, fallbackHeight = 480 }: LogViewProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(fallbackHeight);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight || fallbackHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [fallbackHeight]);

  const total = lines.length * rowHeight;

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || !following) return;
    const bottom = Math.max(0, total - height);
    el.scrollTop = bottom;
    setScrollTop(bottom);
  }, [version, total, height, following]);

  const onScroll = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setFollowing(el.scrollTop + height >= total - rowHeight);
  }, [height, total, rowHeight]);

  const jumpToLatest = () => setFollowing(true);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(lines.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const visible = lines.slice(first, last);

  return (
    <div className="logs">
      <div ref={viewport} className="logs__viewport" onScroll={onScroll} role="log" aria-label="Deployment logs" tabIndex={0}>
        {lines.length === 0 ? (
          <div className="logs__empty">Waiting for output…</div>
        ) : (
          <div className="logs__spacer" style={{ height: total }}>
            <div className="logs__rows" style={{ transform: `translateY(${first * rowHeight}px)` }}>
              {visible.map((line) => (
                <div key={line.seq} className={`logs__row logs__row--${line.level}`} style={{ height: rowHeight }}>
                  <span className="logs__ts">{timeOf(line.ts)}</span>
                  <span className={`logs__stream logs__stream--${line.stream}`}>{line.stream}</span>
                  <span className="logs__msg">{line.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {!following && (
        <button type="button" className="logs__jump" onClick={jumpToLatest}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
