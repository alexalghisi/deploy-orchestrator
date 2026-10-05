import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_STATUSES,
  InvalidTransitionError,
  allTransitions,
  assertTransition,
  canTransition,
  isInFlight,
  isTerminal,
  type DeploymentStatus,
} from '../src/domain/deploymentStatus.js';

describe('deployment status machine', () => {
  it('follows the happy path QUEUED -> BUILDING -> DEPLOYING -> ACTIVE -> REMOVED', () => {
    const path: DeploymentStatus[] = ['QUEUED', 'BUILDING', 'DEPLOYING', 'ACTIVE', 'REMOVED'];
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it('lets a rollback skip the build', () => {
    expect(canTransition('QUEUED', 'DEPLOYING')).toBe(true);
  });

  it('allows failure and cancellation from every in-flight status', () => {
    for (const from of DEPLOYMENT_STATUSES.filter(isInFlight)) {
      expect(canTransition(from, 'FAILED')).toBe(true);
      expect(canTransition(from, 'CANCELLED')).toBe(true);
    }
  });

  it('never goes backwards', () => {
    expect(canTransition('DEPLOYING', 'BUILDING')).toBe(false);
    expect(canTransition('ACTIVE', 'DEPLOYING')).toBe(false);
    expect(canTransition('BUILDING', 'QUEUED')).toBe(false);
  });

  it('cannot cancel or fail an ACTIVE deployment, only remove it', () => {
    expect(canTransition('ACTIVE', 'CANCELLED')).toBe(false);
    expect(canTransition('ACTIVE', 'FAILED')).toBe(false);
  });

  it('treats FAILED, CANCELLED and REMOVED as terminal', () => {
    expect(DEPLOYMENT_STATUSES.filter(isTerminal)).toEqual(['FAILED', 'CANCELLED', 'REMOVED']);
  });

  it('never allows a self transition', () => {
    for (const s of DEPLOYMENT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('throws a typed error on an illegal transition', () => {
    expect(() => assertTransition('FAILED', 'ACTIVE')).toThrow(InvalidTransitionError);
    try {
      assertTransition('CANCELLED', 'BUILDING');
    } catch (err) {
      expect(err).toMatchObject({ from: 'CANCELLED', to: 'BUILDING' });
    }
  });

  it('lists every legal pair exactly once', () => {
    const pairs = allTransitions().map(([a, b]) => `${a}>${b}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toHaveLength(11);
  });
});
