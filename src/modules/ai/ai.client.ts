import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * service token; fails soft so the dashboard degrades gracefully when the AI
 * service is unavailable.
 */
@Injectable()
export class AiClient {
  private readonly logger = new Logger(AiClient.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: ConfigService<AppEnv, true>) {
    this.baseUrl = config.get('AI_SERVICE_URL', { infer: true });
    this.token = config.get('AI_SERVICE_TOKEN', { infer: true });
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult | null> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        this.logger.warn(`AI analyze returned ${res.status}`);
        return null;
      }
      return (await res.json()) as AnalyzeResult;
    } catch (err) {
      this.logger.warn(`AI analyze failed: ${(err as Error).message}`);
      return null;
    }
  }
}
