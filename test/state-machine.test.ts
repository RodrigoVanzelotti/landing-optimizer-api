import { describe, expect, it } from 'vitest';
import { canTransition, TRANSITIONS } from '../src/modules/experiments/experiment-state-machine';

describe('experiment state machine', () => {
  it('allows the happy-path lifecycle', () => {
    expect(canTransition('draft', 'pending_review')).toBe(true);
    expect(canTransition('pending_review', 'approved')).toBe(true);
    expect(canTransition('approved', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'rolled_back')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('draft', 'running')).toBe(false);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('rolled_back', 'running')).toBe(false);
    expect(canTransition('rejected', 'approved')).toBe(false);
  });

  it('is a terminal state for rolled_back', () => {
    expect(TRANSITIONS.rolled_back).toHaveLength(0);
  });
});
