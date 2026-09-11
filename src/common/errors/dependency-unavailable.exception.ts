import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown when an internal dependency (AI service, etc.) fails during a
 * request. Carries the dependency facts ON the exception so the global
 * AllExceptionsFilter can emit them in its single `request_failed` record —
 * the throwing layer must NOT also log, or the incident appears twice in the
 * shared log sink (single-record rule, docs/DEPLOYMENT §8).
 */
export interface DependencyFields {
  dependency: string;
  operation: string;
  reason: string;
  upstream_status?: number | string;
}

export class DependencyUnavailableException extends ServiceUnavailableException {
  constructor(
    message: string,
    readonly dependencyFields: DependencyFields,
  ) {
    super(message);
  }
}
