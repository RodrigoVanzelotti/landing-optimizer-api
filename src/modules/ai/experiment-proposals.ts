import { z } from 'zod';
import { sanitizeSelector } from '../events/event-scrub';

export const InsightExperimentProposalSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  type: z.enum(['copy', 'cta', 'headline']).optional(),
  selector: z.string().min(1).max(256).refine(value => sanitizeSelector(value) === value, 'Unsafe proposal selector'),
  proposedValue: z.string().min(1).max(5000).refine(value => !!value.trim(), 'Empty proposal'),
  originalValue: z.string().max(5000).nullish().transform(value => value ?? undefined).optional(),
});
export const InsightExperimentProposalsSchema = z.array(InsightExperimentProposalSchema).max(10);
export type InsightExperimentProposal = z.infer<typeof InsightExperimentProposalSchema>;
