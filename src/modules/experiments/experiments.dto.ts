import { z } from 'zod';

const ChangeOpEnum = z.enum([
  'set_text',
  'set_html_safe',
  'set_attr',
  'add_class',
  'remove_class',
  'hide',
  'show',
  'reorder',
]);

// Conservative selector allowlist — mirrors the snippet's isSafeSelector.
const SAFE_SELECTOR = /^(?:(?:[a-zA-Z][\w-]*|\*)(?:[.#][a-zA-Z][\w-]*)*|(?:[.#][a-zA-Z][\w-]*)+)(?:(?:\s*[>+~]\s*|\s+)(?:(?:[a-zA-Z][\w-]*|\*)(?:[.#][a-zA-Z][\w-]*)*|(?:[.#][a-zA-Z][\w-]*)+))*$/;

const VariantChangeSchema = z.object({
  selector: z
    .string()
    .min(1)
    .max(256)
    .refine((s) => !/[\[\](){}<'"`;:,]/.test(s) && SAFE_SELECTOR.test(s.trim()), {
      message: 'unsafe or unsupported selector',
    }),
  op: ChangeOpEnum,
  originalValue: z.string().max(5000).optional(),
  proposedValue: z.string().max(5000).optional(),
  attrName: z.string().max(64).optional(),
});

const VariantSchema = z.object({
  name: z.string().min(1).max(60),
  isControl: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(0.5),
  changes: z.array(VariantChangeSchema).max(50).default([]),
});

export const CreateExperimentSchema = z
  .object({
    siteId: z.string().min(1),
    name: z.string().min(1).max(160),
    hypothesis: z.string().max(2000).optional(),
    type: z.enum([
      'copy',
      'cta',
      'headline',
      'subheadline',
      'button_style',
      'section_order',
      'section_visibility',
      'layout_class',
    ]),
    primaryGoalId: z.string().optional(),
    allocation: z.number().min(0).max(1).default(0.5),
    targeting: z
      .object({
        device: z.array(z.enum(['mobile', 'tablet', 'desktop'])).optional(),
        query: z.record(z.string()).optional(),
      })
      .optional(),
    variants: z.array(VariantSchema).min(2).max(6),
  })
  .refine((e) => e.variants.some((v) => v.isControl), {
    message: 'exactly one control variant is required',
    path: ['variants'],
  })
  .refine((e) => e.variants.filter((v) => v.isControl).length === 1, {
    message: 'exactly one control variant is required',
    path: ['variants'],
  });
export type CreateExperimentDto = z.infer<typeof CreateExperimentSchema>;

export const UpdateExperimentSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  hypothesis: z.string().max(2000).optional(),
  allocation: z.number().min(0).max(1).optional(),
  targeting: z
    .object({
      device: z.array(z.enum(['mobile', 'tablet', 'desktop'])).optional(),
      query: z.record(z.string()).optional(),
    })
    .optional(),
});
export type UpdateExperimentDto = z.infer<typeof UpdateExperimentSchema>;

export const ApproveSchema = z.object({
  reason: z.string().max(1000).optional(),
  checklist: z.record(z.boolean()).optional(),
  screenshotUrl: z.string().url().max(1000).optional(),
});
export type ApproveDto = z.infer<typeof ApproveSchema>;

export const RejectSchema = z.object({ reason: z.string().min(1).max(1000) });
export type RejectDto = z.infer<typeof RejectSchema>;

export const ScheduleSchema = z.object({ startAt: z.string().datetime() });
export type ScheduleDto = z.infer<typeof ScheduleSchema>;

export const CompleteSchema = z.object({ winnerVariantId: z.string().optional() });
export type CompleteDto = z.infer<typeof CompleteSchema>;
