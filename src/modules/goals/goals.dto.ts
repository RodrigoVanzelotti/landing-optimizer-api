import { z } from 'zod';

/**
 * Conversion goal matchers, keyed by goal kind. The matcher shape is validated
 * against the goal's `kind` so a stored matcher is always meaningful
 * (docs/DATABASE_SCHEMA.md conversion_goal, docs/EVENT_SCHEMA.md §3):
 *  - `event`       matched by the goal name passed to `conversion(name)`.
 *  - `url`         matched against the (query-stripped) page path.
 *  - `form_submit` matched on a `form_submit` event, optionally by selector.
 */
const EventMatcherSchema = z.object({}).strict().default({});

const UrlMatcherSchema = z
  .object({
    op: z.enum(['exact', 'prefix', 'contains', 'regex']).default('exact'),
    path: z.string().min(1).max(1024),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.op === 'regex') {
      try {
        // Validate the pattern compiles; never executed against user input here.
        new RegExp(m.path);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['path'],
          message: 'invalid regular expression',
        });
      }
    }
  });

const FormSubmitMatcherSchema = z
  .object({
    selector: z.string().min(1).max(256).optional(),
  })
  .strict()
  .default({});

const MATCHER_SCHEMAS = {
  event: EventMatcherSchema,
  url: UrlMatcherSchema,
  form_submit: FormSubmitMatcherSchema,
} as const;

export type GoalKind = keyof typeof MATCHER_SCHEMAS;

/** Returns the matcher schema for a goal kind. Exported for unit tests. */
export function matcherSchemaFor(kind: GoalKind): z.ZodTypeAny {
  return MATCHER_SCHEMAS[kind];
}

/**
 * Validate + normalize a matcher against its kind. Applies defaults (e.g. url
 * `op` → `exact`). Throws a ZodError on invalid input.
 */
export function parseGoalMatcher(kind: GoalKind, matcher: unknown): Record<string, unknown> {
  return matcherSchemaFor(kind).parse(matcher ?? {}) as Record<string, unknown>;
}

const GoalNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\w][\w .-]*$/, 'name may contain letters, numbers, spaces, dots and dashes');

export const CreateGoalSchema = z
  .object({
    name: GoalNameSchema,
    kind: z.enum(['event', 'url', 'form_submit']).default('event'),
    matcher: z.unknown().optional(),
  })
  .transform((val, ctx) => {
    const parsed = matcherSchemaFor(val.kind).safeParse(val.matcher ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ['matcher', ...issue.path] });
      }
      return z.NEVER;
    }
    return { name: val.name, kind: val.kind, matcher: parsed.data as Record<string, unknown> };
  });
export type CreateGoalDto = z.infer<typeof CreateGoalSchema>;

export const UpdateGoalSchema = z.object({
  name: GoalNameSchema.optional(),
  // Validated against the goal's fixed kind server-side (kind is immutable).
  matcher: z.unknown().optional(),
});
export type UpdateGoalDto = z.infer<typeof UpdateGoalSchema>;
