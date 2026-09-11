import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DependencyUnavailableException } from '../../common/errors/dependency-unavailable.exception';
import { safeReason } from '../../common/logging/request-context';
import type { AppEnv } from '../../config/env';

export interface AnalyzeInput {
  siteId: string;
  pageMap: unknown;
  metrics: Record<string, unknown>;
  guardrails?: Record<string, unknown>;
}

export interface AiSuggestionOut {
  kind: 'hypothesis' | 'headline' | 'cta' | 'friction' | 'section' | 'score' | 'plan';
  title: string;
  detail: string;
  selector?: string;
  proposedValue?: string;
  originalValue?: string;
  expectedImpact?: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface AnalyzeResult {
  model: string;
  score: number;
  suggestions: AiSuggestionOut[];
}

/**
 * Thin client for the internal AI service (Python FastAPI). Uses a bearer
 * service token. Failures throw DependencyUnavailableException with the
 * dependency facts attached — the global exception filter emits the single
 * log record for the incident (single-record rule); this client never logs.
 */
@Injectable()
export class AiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: ConfigService<AppEnv, true>) {
    this.baseUrl = config.get('AI_SERVICE_URL', { infer: true });
    this.token = config.get('AI_SERVICE_TOKEN', { infer: true });
  }

  async analyze(input: AnalyzeInput, requestId?: string): Promise<AnalyzeResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/internal/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(requestId ? { 'X-Request-ID': requestId } : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new DependencyUnavailableException('AI service unavailable', {
        dependency: 'ai',
        operation: 'analyze',
        reason: safeReason(err),
        upstream_status: 'unreachable',
      });
    }
    if (!res.ok) {
      throw new DependencyUnavailableException('AI service unavailable', {
        dependency: 'ai',
        operation: 'analyze',
        reason: 'upstream_error',
        upstream_status: res.status,
      });
    }
    return (await res.json()) as AnalyzeResult;
  }
}
