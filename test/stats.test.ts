import { describe, expect, it } from 'vitest';
import { analyzeExperiment, twoProportionPValue } from '../src/modules/analytics/stats';
import { canonicalJson } from '../src/common/crypto/canonical-json';

describe('stats.analyzeExperiment', () => {
  it('computes lift and significance vs control', () => {
    const results = analyzeExperiment([
      { variantId: 'c', isControl: true, exposures: 1000, conversions: 100 },
      { variantId: 'v', isControl: false, exposures: 1000, conversions: 160 },
    ]);
    const control = results.find((r) => r.variantId === 'c')!;
    const variant = results.find((r) => r.variantId === 'v')!;
    expect(control.conversionRate).toBeCloseTo(0.1, 5);
    expect(variant.conversionRate).toBeCloseTo(0.16, 5);
    expect(variant.lift).toBeCloseTo(0.6, 5);
    expect(variant.pValue).not.toBeNull();
    expect(variant.significant).toBe(true);
  });

  it('returns null p-value when underpowered', () => {
    const p = twoProportionPValue(
      { variantId: 'a', isControl: true, exposures: 5, conversions: 1 },
      { variantId: 'b', isControl: false, exposures: 5, conversions: 2 },
    );
    expect(p).toBeNull();
  });
});

describe('canonicalJson', () => {
  it('matches the snippet canonicalization (sorted keys)', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
  });
});
