import { expect, it } from 'vitest';
import { bernoulliSequence, evaluationPlan, evaluateEvidence, type EvaluationPlan } from '../src/modules/experiments/experiment-evidence';

const from = new Date('2026-11-01T00:00:00Z');
const plan: EvaluationPlan = { version: 1, analysisFrom: from.toISOString(), monthlyVisits: 10000, baselineRate: .1, minimumPerArm: 1000, estimatedDays: 30, relativeEffect: .1 };
const now = new Date('2026-11-20T00:00:00Z');
const control = { variantId: 'control', isControl: true, exposures: 2_000_000, conversions: 200_000 };
it('matches exact one-trial Jeffreys mixture boundaries and handles no data safely', () => {
  expect(bernoulliSequence(0, 1, .05)[1]).toBeCloseTo(.975, 10);
  expect(bernoulliSequence(1, 1, .05)[0]).toBeCloseTo(.025, 10);
  expect(bernoulliSequence(2, 1, .05)).toEqual([0, 1]);
  expect(bernoulliSequence(0, 0, .05)).toEqual([0, 1]);
  const bounds = bernoulliSequence(100000, 1000000, .025);
  expect(bounds[0]).toBeLessThan(.1); expect(bounds[1]).toBeGreaterThan(.1); expect(bounds[1]).toBeLessThan(.12);
});
it('sizes for 10% relative effect and uses monthly traffic without allowing missing historical data to fabricate a plan', () => {
  const small = evaluationPlan(1000, 100, .5, [.5, .5], from)!;
  const large = evaluationPlan(10_000_000, 1_000_000, .5, [.5, .5], from)!;
  expect(small.relativeEffect).toBe(.1);
  expect(large.minimumPerArm).toBeGreaterThan(small.minimumPerArm);
  expect(small.estimatedDays).toBeGreaterThan(large.estimatedDays);
  expect(evaluationPlan(0, 0, .5, [.5, .5], from)).toBeNull();
  expect(evaluationPlan(100, 0, .5, [.5, .5], from)?.baselineRate).toBeGreaterThan(0);
  expect(evaluationPlan(100, 101, .5, [.5, .5], from)).toBeNull();
});
it.each([[240000, 'improvement'], [160000, 'decline'], [200000, 'equivalent']] as const)('concludes only supported evidence (%s / %s)', (conversions, decision) => {
  const result = evaluateEvidence([control, { ...control, variantId: 'proposal', isControl: false, conversions }], plan, now);
  expect(result.conclusive).toBe(true); expect(result.variants[0]?.decision).toBe(decision);
});
it('does not confuse nonsignificance or a tiny sample with equivalence, and waits for every proposal and a full week', () => {
  const proposal = { ...control, variantId: 'proposal', isControl: false };
  expect(evaluateEvidence([control, { ...proposal, exposures: 30, conversions: 3 }], plan, now).conclusive).toBe(false);
  expect(evaluateEvidence([control, proposal], plan, from).conclusive).toBe(false);
  expect(evaluateEvidence([control, proposal, { ...proposal, variantId: 'unexposed', exposures: 0, conversions: 0 }], plan, now).conclusive).toBe(false);
  expect(evaluateEvidence([], plan, now).conclusive).toBe(false);
  const perfect = { ...control, conversions: control.exposures };
  expect(evaluateEvidence([perfect, { ...perfect, variantId: 'proposal', isControl: false }], plan, now).variants[0]?.decision).toBe('equivalent');
});
