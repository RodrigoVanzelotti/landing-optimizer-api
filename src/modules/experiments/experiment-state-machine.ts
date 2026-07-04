import { ExperimentStatus } from '@prisma/client';

/**
 * The experiment approval/lifecycle state machine (docs/API_CONTRACTS.md §B).
 * Every transition is validated server-side; invalid transitions are rejected
 * with 409 Conflict.
 */
export const TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  draft: ['pending_review'],
  ai_suggested: ['draft', 'pending_review', 'rejected'],
  pending_review: ['approved', 'rejected'],
  approved: ['scheduled', 'running'],
  scheduled: ['running', 'paused', 'rolled_back'],
  running: ['paused', 'completed', 'rolled_back'],
  paused: ['running', 'completed', 'rolled_back'],
  completed: ['rolled_back'],
  rejected: ['draft'],
  rolled_back: [],
};

export function canTransition(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses in which the experiment is live and included in the signed config. */
export const LIVE_STATUSES: ExperimentStatus[] = ['running'];

/** Statuses in which structural edits to variants/changes are still allowed. */
export const EDITABLE_STATUSES: ExperimentStatus[] = ['draft', 'ai_suggested'];
