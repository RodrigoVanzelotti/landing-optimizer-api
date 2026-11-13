import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../../config/env';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Shared authentication for the public edge surface (events + snapshots):
 * resolves a site by id, verifies the public ingest key in constant time, and
 * checks current site and tenant permissions on every batch.
 */

export interface SiteAuth {
  siteId: string;
  tenantId: string;
  active: boolean;
  origins: string[];
}

@Injectable()
export class SiteAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async resolveSite(siteId: string, ingestKey: string): Promise<SiteAuth | null> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, tenantId: true, ingestKey: true, status: true, origins: { select: { origin: true } }, tenant: { select: { archivedAt: true } } },
    });
    if (!site || site.tenant.archivedAt || !this.constantTimeEq(site.ingestKey, ingestKey)) return null;
    return { siteId: site.id, tenantId: site.tenantId, active: site.status === 'active', origins: site.origins.map(o => o.origin) };
  }

  originAllowed(site: SiteAuth, origin: string | undefined): boolean {
    if (site.origins.length === 0) return false;
    if (!origin) return false;
    try {
      const normalized = new URL(origin).origin;
      return site.origins.includes(normalized);
    } catch {
      return false;
    }
  }

  /** Non-reversible, daily-rotating, per-site session pseudonym. */
  pseudoSession(sid: string, siteId: string): string {
    return this.hash(`${sid}:${siteId}:${this.dailySalt()}`).slice(0, 32);
  }

  dailySalt(): string {
    const day = new Date().toISOString().slice(0, 10);
    return createHmac('sha256', this.config.get('JWT_SECRET', { infer: true })).update(`lo-analytics:${day}`).digest('hex').slice(0, 32);
  }

  hash(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private constantTimeEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
}
