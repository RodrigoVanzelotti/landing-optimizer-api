import { describe, expect, it } from 'vitest';
import {
  GuardrailRulesSchema,
  normalizeGuardrailRules,
} from '../src/modules/guardrails/guardrails.dto';

describe('GuardrailRulesSchema', () => {
  it('accepts the documented rule shape', () => {
    const rules = GuardrailRulesSchema.parse({
      tone: 'confident',
      bannedWords: ['cheap', 'free'],
      maxLength: 80,
      mustKeepClaims: ['SOC 2 certified'],
    });
    expect(rules.bannedWords).toEqual(['cheap', 'free']);
    expect(rules.maxLength).toBe(80);
  });

  it('rejects unknown keys and non-positive maxLength', () => {
    expect(() => GuardrailRulesSchema.parse({ foo: 'bar' })).toThrow();
    expect(() => GuardrailRulesSchema.parse({ maxLength: 0 })).toThrow();
    expect(() => GuardrailRulesSchema.parse({ maxLength: -5 })).toThrow();
  });
});

describe('normalizeGuardrailRules', () => {
  it('dedupes banned words case-insensitively and preserves the first casing', () => {
    const clean = normalizeGuardrailRules({ bannedWords: ['Free', 'free', 'FREE', 'cheap'] });
    expect(clean.bannedWords).toEqual(['Free', 'cheap']);
  });

  it('drops empty collections so stored rules stay compact', () => {
    expect(normalizeGuardrailRules({ bannedWords: [], mustKeepClaims: [] })).toEqual({});
  });
});
