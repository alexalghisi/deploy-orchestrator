export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function summary(label: string, values: readonly number[], unit = 'ms'): string {
  const f = (v: number) => `${v.toFixed(1)} ${unit}`;
  return `${label.padEnd(44)} n=${String(values.length).padEnd(5)} p50 ${f(percentile(values, 50)).padEnd(11)} p95 ${f(percentile(values, 95)).padEnd(11)} max ${f(Math.max(...values))}`;
}
