import { z } from 'zod';
import { reportRange } from '../../modules/analytics/report';

export const AuditQuerySchema = z.object({
  timeframe: z.enum(['7d', '30d', '6m', '1y']).default('30d'),
  action: z.string().trim().min(1).max(100).optional(),
  actorUserId: z.string().trim().min(1).max(128).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().min(1).max(128).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export const LegacyAuditQuerySchema = AuditQuerySchema.pick({ action: true });
export function auditRange(timeframe: AuditQuery['timeframe'], now = new Date()) {
  const range = reportRange(timeframe, now);
  // Audit includes today's actions; retain calendar clamping from the shared presets.
  return { from: new Date(Date.parse(range.from) + now.getTime() - Date.parse(range.to)), to: now };
}
