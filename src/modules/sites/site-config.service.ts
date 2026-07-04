import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.module';
import { CryptoService } from '../../common/crypto/crypto.service';

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
  targeting?: Record<string, unknown>;
  variants: WireVariant[];
}
export interface SignedSiteConfig {
  siteId: string;
  version: number;
  sampling: number;
  experiments: WireExperiment[];
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
  async publish(siteId: string): Promise<SignedSiteConfig> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new Error('site not found');

    const experiments = await this.prisma.experiment.findMany({
      where: { siteId, status: 'running' },
      include: { variants: { include: { changes: true } } },
    });

    const version = site.configVersion + 1;
    const wireExperiments: WireExperiment[] = experiments.map((exp) => ({
      id: exp.id,
      allocation: Number(exp.allocation),
      targeting: normalizeTargeting(exp.targeting),
      variants: exp.variants.map((v) => ({
        id: v.id,
        weight: Number(v.weight),
        isControl: v.isControl,
        changes: v.changes.map((c) => {
          const change: WireChange = { selector: c.selector, op: c.op };
          if (c.proposedValue !== null) change.value = c.proposedValue;
          if (c.attrName !== null) change.attr = c.attrName;
          return change;
        }),
      })),
    }));

    const unsigned = {
      siteId: site.id,
      version,
      sampling: Number(site.samplingRate),
      experiments: wireExperiments,
    };
    const sig = this.crypto.signConfig(site.privateKeyEnc, unsigned);
    const signed: SignedSiteConfig = { ...unsigned, sig };

    await this.prisma.site.update({
      where: { id: siteId },
      data: { configVersion: version },
    });
    await this.redis.set(cacheKey(siteId), JSON.stringify(signed), CONFIG_TTL_SECONDS);
    return signed;
  }

  /** Read from cache; rebuild on miss. Returns null for unknown/paused sites. */
  async get(siteId: string): Promise<SignedSiteConfig | null> {
    const cached = await this.redis.get(cacheKey(siteId));
    if (cached) {
      try {
        return JSON.parse(cached) as SignedSiteConfig;
      } catch {
        /* fall through to rebuild */
      }
    }
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site || site.status !== 'active') return null;
    return this.publish(siteId);
  }
}

function normalizeTargeting(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && Object.keys(value).length > 0) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
