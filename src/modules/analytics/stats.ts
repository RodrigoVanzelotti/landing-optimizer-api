/**
 * Frequentist significance for A/B conversion-rate comparison. Uses a
 * two-proportion z-test with a normal-approximation two-tailed p-value. This is
 * an MVP implementation; docs/ROADMAP.md tracks Bayesian/sequential upgrades.
 */

export interface VariantStat {
  variantId: string;
  isControl: boolean;
  exposures: number;
  conversions: number;
}

export interface VariantResult extends VariantStat {
  conversionRate: number;
  /** Relative lift vs control (fraction); null for the control itself. */
  lift: number | null;
  /** Two-tailed p-value vs control; null for control or insufficient data. */
  pValue: number | null;
  significant: boolean;
}

const ALPHA = 0.05;

export function analyzeExperiment(stats: VariantStat[]): VariantResult[] {
  const control = stats.find((s) => s.isControl) ?? stats[0];
  if (!control) return [];
  const cRate = rate(control);

  return stats.map((s) => {
    const r = rate(s);
    if (s.variantId === control.variantId) {
      return {
        ...s,
        conversionRate: r,
        lift: null,
        pValue: null,
        significant: false,
      };
    }
    const p = twoProportionPValue(control, s);
    return {
      ...s,
      conversionRate: r,
      lift: cRate > 0 ? (r - cRate) / cRate : null,
      pValue: p,
      significant: p !== null && p < ALPHA,
    };
  });
}

function rate(s: VariantStat): number {
  return s.exposures > 0 ? s.conversions / s.exposures : 0;
}

/** Two-proportion z-test; returns a two-tailed p-value or null if underpowered. */
export function twoProportionPValue(a: VariantStat, b: VariantStat): number | null {
  if (a.exposures < 30 || b.exposures < 30) return null;
  const p1 = a.conversions / a.exposures;
  const p2 = b.conversions / b.exposures;
  const pPool = (a.conversions + b.conversions) / (a.exposures + b.exposures);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.exposures + 1 / b.exposures));
  if (se === 0) return null;
  const z = (p2 - p1) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
