import type { ExperimentStatus } from '@prisma/client';

export const EXPERIMENT_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
export const UNSTARTED_STATUSES: ExperimentStatus[] = ['draft', 'ai_suggested', 'pending_review', 'approved', 'scheduled'];

export function experimentValidity(experiment: { status: ExperimentStatus; createdAt: Date; startedAt?: Date | null }, now = Date.now()) {
  const expiresAt = UNSTARTED_STATUSES.includes(experiment.status) || (experiment.status === 'paused' && experiment.startedAt === null)
    ? new Date(experiment.createdAt.getTime() + EXPERIMENT_VALIDITY_MS) : null;
  return { expiresAt, expired: expiresAt !== null && expiresAt.getTime() <= now };
}
