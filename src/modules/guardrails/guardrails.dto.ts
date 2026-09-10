import { z } from 'zod';

/**
 * Brand guardrail rules (docs/DATABASE_SCHEMA.md brand_guardrail). These are
 * server-side constraints consumed by the AI service
 * (landing-optimizer-ai `apply_guardrails`): `bannedWords` and `maxLength` are
 * hard-enforced there (banned copy is dropped, long copy is trimmed), while
 * `tone` and `mustKeepClaims` steer generation. They are never shipped to the
 * browser, so changing them does not require republishing the signed config.
 */
export const GuardrailRulesSchema = z
  .object({
    tone: z.string().trim().max(500).optional(),
    bannedWords: z.array(z.string().trim().min(1).max(80)).max(500).optional(),
    maxLength: z.number().int().positive().max(10000).optional(),
    mustKeepClaims: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
  })
  .strict();
export type GuardrailRules = z.infer<typeof GuardrailRulesSchema>;

export const PutGuardrailSchema = z.object({
  rules: GuardrailRulesSchema,
});
export type PutGuardrailDto = z.infer<typeof PutGuardrailSchema>;

/**
 * Clean rules for storage: dedupe banned words case-insensitively (preserving
 * the first casing for display) and drop empty collections so stored rules stay
 * compact. The AI service lowercases at match time.
 */
export function normalizeGuardrailRules(rules: GuardrailRules): GuardrailRules {
  const out: GuardrailRules = {};
  if (rules.tone) out.tone = rules.tone;
  if (rules.maxLength !== undefined) out.maxLength = rules.maxLength;

  if (rules.bannedWords) {
    const seen = new Set<string>();
    const words: string[] = [];
    for (const word of rules.bannedWords) {
      const key = word.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        words.push(word);
      }
    }
    if (words.length > 0) out.bannedWords = words;
  }

  if (rules.mustKeepClaims) {
    const claims = rules.mustKeepClaims.filter((claim) => claim.length > 0);
    if (claims.length > 0) out.mustKeepClaims = claims;
  }

  return out;
}
