import type { VariantResult, VariantStat } from '../analytics/stats';

export const MINIMUM_RELATIVE_EFFECT = 0.1;
export const MINIMUM_DURATION_MS = 7 * 86_400_000;
export interface EvaluationPlan {
  version: 1; analysisFrom: string; monthlyVisits: number; baselineRate: number;
  minimumPerArm: number; estimatedDays: number; relativeEffect: number;
}

export function evaluationPlan(visits: number, conversions: number, allocation: number, weights: number[], analysisFrom: Date): EvaluationPlan | null {
  if (visits < 30 || conversions < 0 || conversions > visits || allocation <= 0 || weights.length < 2 || weights.some(weight => weight <= 0)) return null;
  // Jeffreys smoothing sizes the plan even when the historical count is zero; it is not an observed KPI.
  const baselineRate = (conversions + .5) / (visits + 1);
  const delta = Math.min(baselineRate * MINIMUM_RELATIVE_EFFECT, (1 - baselineRate) / 2);
  const statisticalMinimum = Math.ceil(2 * baselineRate * (1 - baselineRate) * (1.96 + .842) ** 2 / delta ** 2);
  const smallestShare = Math.min(...weights) / weights.reduce((sum, weight) => sum + weight, 0);
  const dailyPerArm = visits / 30 * allocation * smallestShare;
  const minimumPerArm = Math.max(30, Math.ceil(7 * dailyPerArm));
  return { version: 1, analysisFrom: analysisFrom.toISOString(), monthlyVisits: visits, baselineRate, minimumPerArm, estimatedDays: Math.max(7, Math.ceil(statisticalMinimum / dailyPerArm)), relativeEffect: MINIMUM_RELATIVE_EFFECT };
}

// Beta-binomial mixture confidence sequence (Jeffreys mixture), valid under continuous monitoring.
// https://arxiv.org/abs/1810.08240; Bonferroni covers all arms simultaneously at 95%.
export function bernoulliSequence(successes: number, trials: number, alpha: number): [number, number] {
  if (!Number.isSafeInteger(trials) || !Number.isSafeInteger(successes) || trials <= 0 || successes < 0 || successes > trials || alpha <= 0 || alpha >= 1) return [0, 1];
  const rate = successes / trials;
  const logBeta = (a: number, b: number) => logGamma(a) + logGamma(b) - logGamma(a + b);
  const mixture = logBeta(successes + .5, trials - successes + .5) - logBeta(.5, .5);
  const outside = (p: number) => mixture - (successes ? successes * Math.log(p) : 0) - (trials > successes ? (trials - successes) * Math.log1p(-p) : 0) >= Math.log(1 / alpha);
  function boundary(left: number, right: number, lower: boolean) {
    for (let i = 0; i < 60; i++) {
      const midpoint = (left + right) / 2;
      if (outside(midpoint) === lower) left = midpoint; else right = midpoint;
    }
    return (left + right) / 2;
  }
  return [successes === 0 ? 0 : boundary(0, rate, true), successes === trials ? 1 : boundary(rate, 1, false)];
}

export function evaluateEvidence(stats: VariantStat[], plan: EvaluationPlan, now: Date) {
  const control = stats.find(variant => variant.isControl);
  const proposals = stats.filter(variant => !variant.isControl);
  const ready = control && proposals.length > 0 && stats.every(variant => variant.exposures >= plan.minimumPerArm && variant.conversions >= 0 && variant.conversions <= variant.exposures) && now.getTime() - Date.parse(plan.analysisFrom) >= MINIMUM_DURATION_MS;
  const reference = control ? bernoulliSequence(control.conversions, control.exposures, .05 / stats.length) : [0, 1];
  const variants = proposals.map(variant => {
    const interval = bernoulliSequence(variant.conversions, variant.exposures, .05 / stats.length);
    const lower = interval[0]! - reference[1]!, upper = interval[1]! - reference[0]!;
    const decision: NonNullable<VariantResult['decision']> = !ready ? 'collecting' : interval[0] > reference[1]! * (1 + plan.relativeEffect) ? 'improvement' : interval[1] < reference[0]! * (1 - plan.relativeEffect) ? 'decline' : interval[0] > reference[1]! * (1 - plan.relativeEffect) && interval[1] < reference[0]! * (1 + plan.relativeEffect) ? 'equivalent' : 'collecting';
    return { variantId: variant.variantId, lower, upper, decision };
  });
  return { conclusive: Boolean(ready && variants.every(variant => variant.decision !== 'collecting')), variants };
}

function logGamma(value: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  const z = value - 1;
  let sum = .9999999999998099;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i]! / (z + i + 1);
  const t = z + 7.5;
  return .5 * Math.log(2 * Math.PI) + (z + .5) * Math.log(t) - t + Math.log(sum);
}
