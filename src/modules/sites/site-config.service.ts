import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.module';
import { CryptoService } from '../../common/crypto/crypto.service';
import { writeAudit } from '../../common/audit/audit.module';
import type { Prisma } from '@prisma/client';
import type { ElementVisibleMatcher } from '../goals/goals.dto';
import { readJourney, type Journey } from '../analytics/journey';

/** Wire shape served to the snippet — mirrors snippet/src/types.ts SiteConfig. */
export interface WireChange {
  selector: string;
  op: string;
  value?: string;
  attr?: string;
}
export interface WireVariant {
  id: string;
  weight: number;
  isControl: boolean;
  changes: WireChange[];
}
export interface WireExperiment {
  id: string;
  allocation: number;
  permanent?: true;
  targeting?: Record<string, unknown>;
  variants: WireVariant[];
}
export interface SignedSiteConfig {
  siteId: string;
  version: number;
  sampling: number;
  experiments: WireExperiment[];
  confirmationRules?: ElementVisibleMatcher[];
  journey?: Journey;
  sig: string;
}

const cacheKey = (siteId: string): string => `config:${siteId}`;
const CONFIG_TTL_SECONDS = 3600;

/**
 * Compiles the running experiments for a site into a signed config document,
 * caches it in Redis, and serves it to the public config endpoint. The signing
 * canonicalization matches the snippet so the browser can verify it.
 */
@Injectable()
export class SiteConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
  ) {}

  /** Rebuild, sign, cache, and return the config; bumps the site version. */
  async publish(siteId: string, actorUserId?: string): Promise<SignedSiteConfig> {
    const signed = await this.prisma.$transaction(async tx => {
      // Serialize publishers so versions and compiled experiment sets stay ordered.
      await tx.$queryRaw`SELECT id FROM site WHERE id = ${siteId} FOR UPDATE`;
      const site = await tx.site.update({ where: { id: siteId }, data: { configVersion: { increment: 1 } } });
      const result = await this.compile(siteId, tx);
      if (actorUserId) await writeAudit(tx, { tenantId: site.tenantId, actorUserId, action: 'site.config_published', targetType: 'site', targetId: siteId, metadata: { version: result.version } });
      await this.redis.set(cacheKey(siteId), JSON.stringify(result), CONFIG_TTL_SECONDS);
      return result;
    });
    return signed;
  }

  private async compile(siteId: string, db: Prisma.TransactionClient = this.prisma): Promise<SignedSiteConfig> {
    const site = await db.site.findUnique({ where: { id: siteId } });
    if (!site) throw new Error('site not found');

    const experiments = await db.experiment.findMany({
      where: { siteId, status: { in: ['running', 'accepted'] } },
      include: { variants: { include: { changes: true } } },
    });

    const version = site.configVersion;
    const wireExperiments: WireExperiment[] = experiments.filter(exp => exp.status !== 'accepted' || exp.variants.some(variant => variant.id === exp.winnerVariantId && !variant.isControl)).map((exp) => ({
      id: exp.id,
      allocation: exp.status === 'accepted' ? 1 : Number(exp.allocation),
      ...(exp.status === 'accepted' ? { permanent: true as const } : {}),
      targeting: normalizeTargeting(exp.targeting),
      variants: exp.variants.filter(variant => exp.status !== 'accepted' || variant.id === exp.winnerVariantId).map((v) => ({
        id: v.id,
        weight: exp.status === 'accepted' ? 1 : Number(v.weight),
        isControl: v.isControl,
        changes: v.changes.map((c) => {
          const change: WireChange = { selector: c.selector, op: c.op };
          if (c.proposedValue !== null) change.value = c.proposedValue;
          if (c.attrName !== null) change.attr = c.attrName;
          return change;
        }),
      })),
    }));

    const goals = await db.conversionGoal.findMany({
      where: { siteId, kind: 'element_visible' },
      select: { matcher: true },
      orderBy: { id: 'asc' },
    });
    const confirmationRules = Array.from(new Map(goals.map(goal => {
      const { path, selector, formSelector } = goal.matcher as ElementVisibleMatcher;
      return [JSON.stringify([path, selector, formSelector]), { path, selector, ...(formSelector ? { formSelector } : {}) }];
    })).values());

    const journey = readJourney(site.settings);
    if (journey.globalEvent && !await db.conversionGoal.findFirst({
      where: { siteId, kind: 'event', name: journey.globalEvent.goal }, select: { id: true },
    })) delete journey.globalEvent;
    const unsigned = {
      siteId: site.id,
      version,
      sampling: Number(site.samplingRate),
      experiments: wireExperiments,
      ...(confirmationRules.length ? { confirmationRules } : {}),
      ...(journey.steps.length || journey.globalEvent ? { journey } : {}),
    };
    const sig = this.crypto.signConfig(site.privateKeyEnc, unsigned);
    return { ...unsigned, sig };
  }

  /** Read from cache; rebuild on miss. Returns null for unknown/paused sites. */
  async get(siteId: string): Promise<SignedSiteConfig | null> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, include: { tenant: { select: { archivedAt: true } } } });
    if (!site || site.status !== 'active' || site.tenant.archivedAt) return null;
    const cached = await this.redis.get(cacheKey(siteId));
    if (cached) {
      try {
        const config = JSON.parse(cached) as SignedSiteConfig;
        if (config.siteId === siteId && config.version === site.configVersion) return config;
      } catch {
        /* fall through to rebuild */
      }
    }
    return this.prisma.$transaction(async tx => {
      const sites = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM site WHERE id = ${siteId} AND status = 'active' FOR SHARE`;
      if (!sites.length) return null;
      const config = await this.compile(siteId, tx);
      await this.redis.set(cacheKey(siteId), JSON.stringify(config), CONFIG_TTL_SECONDS);
      return config;
    });
  }
}

function normalizeTargeting(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && Object.keys(value).length > 0) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
