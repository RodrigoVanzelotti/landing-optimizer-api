import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { newId } from '../../common/crypto/ids';
import type { AppEnv } from '../../config/env';
import type { AddOriginDto, CreateSiteDto, UpdateSiteDto } from './sites.dto';
import type { Prisma } from '@prisma/client';

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async create(tenantId: string, dto: CreateSiteDto): Promise<PublicSite> {
    const { publicKey, privateKeyEnc } = this.crypto.generateSiteKeyPair();
    const id = newId();
    const ingestKey = 'ik_' + randomBytes(18).toString('base64url');

    const site = await this.prisma.site.create({
      data: {
        id,
        tenantId,
        name: dto.name,
        primaryDomain: dto.primaryDomain,
        publicKey,
        privateKeyEnc: Buffer.from(privateKeyEnc),
        ingestKey,
        origins: {
          create: {
            id: newId(),
            origin: normalizeOrigin(dto.primaryDomain),
          },
        },
      },
    });
    return toPublicSite(site);
  }

  async list(tenantId: string): Promise<PublicSite[]> {
    const sites = await this.prisma.site.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return sites.map(toPublicSite);
  }

  async get(tenantId: string, id: string): Promise<PublicSite> {
    const site = await this.requireSite(tenantId, id);
    return toPublicSite(site);
  }

  async update(tenantId: string, id: string, dto: UpdateSiteDto): Promise<PublicSite> {
    await this.requireSite(tenantId, id);
    const data: Prisma.SiteUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.samplingRate !== undefined) data.samplingRate = dto.samplingRate;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.settings !== undefined) data.settings = dto.settings as Prisma.InputJsonValue;
    const site = await this.prisma.site.update({ where: { id }, data });
    return toPublicSite(site);
  }

  async listOrigins(tenantId: string, id: string): Promise<{ id: string; origin: string }[]> {
    await this.requireSite(tenantId, id);
    return this.prisma.siteOrigin.findMany({
      where: { siteId: id },
      select: { id: true, origin: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addOrigin(tenantId: string, id: string, dto: AddOriginDto): Promise<void> {
    await this.requireSite(tenantId, id);
    const origin = normalizeOrigin(dto.origin);
    await this.prisma.siteOrigin.upsert({
      where: { siteId_origin: { siteId: id, origin } },
      update: {},
      create: { id: newId(), siteId: id, origin },
    });
  }

  async removeOrigin(tenantId: string, id: string, originId: string): Promise<void> {
    await this.requireSite(tenantId, id);
    await this.prisma.siteOrigin.deleteMany({ where: { id: originId, siteId: id } });
  }

  /** Returns the one-line install snippet + GTM instructions for a site. */
  async snippet(tenantId: string, id: string): Promise<SnippetResponse> {
    const site = await this.requireSite(tenantId, id);
    const version = this.config.get('SDK_VERSION', { infer: true });
    const sdkUrl = `${this.config.get('CDN_SDK_BASE_URL', { infer: true })}/v${version}/lo.js`;
    const ingestUrl = this.config.get('INGEST_URL', { infer: true });
    const configUrl = this.config.get('CONFIG_URL', { infer: true });

    const html = buildSnippet({
      siteId: site.id,
      ingestKey: site.ingestKey,
      publicKey: site.publicKey,
      sdkUrl,
      ingestUrl,
      configUrl,
    });

    return {
      siteId: site.id,
      html,
      gtm: {
        instructions:
          'Create a Custom HTML tag in GTM, paste the snippet, and fire it on All Pages.',
        html,
      },
      csp: {
        scriptSrc: new URL(sdkUrl).origin,
        connectSrc: [new URL(ingestUrl).origin, new URL(configUrl).origin],
      },
    };
  }

  private async requireSite(tenantId: string, id: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access denied');
    return site;
  }
}

/* ------------------------------- helpers -------------------------------- */

export interface PublicSite {
  id: string;
  name: string;
  primaryDomain: string;
  publicKey: string;
  ingestKey: string;
  samplingRate: number;
  status: string;
  settings: unknown;
  configVersion: number;
  createdAt: Date;
}

export interface SnippetResponse {
  siteId: string;
  html: string;
  gtm: { instructions: string; html: string };
  csp: { scriptSrc: string; connectSrc: string[] };
}

function toPublicSite(site: {
  id: string;
  name: string;
  primaryDomain: string;
  publicKey: string;
  ingestKey: string;
  samplingRate: unknown;
  status: string;
  settings: unknown;
  configVersion: number;
  createdAt: Date;
}): PublicSite {
  return {
    id: site.id,
    name: site.name,
    primaryDomain: site.primaryDomain,
    publicKey: site.publicKey,
    ingestKey: site.ingestKey,
    samplingRate: Number(site.samplingRate),
    status: site.status,
    settings: site.settings,
    configVersion: site.configVersion,
    createdAt: site.createdAt,
  };
}

function normalizeOrigin(input: string): string {
  try {
    if (/^https?:\/\//i.test(input)) return new URL(input).origin;
    return new URL(`https://${input}`).origin;
  } catch {
    return input;
  }
}

interface SnippetParams {
  siteId: string;
  ingestKey: string;
  publicKey: string;
  sdkUrl: string;
  ingestUrl: string;
  configUrl: string;
}

function buildSnippet(p: SnippetParams): string {
  const cfg = JSON.stringify(
    {
      siteId: p.siteId,
      ingestKey: p.ingestKey,
      publicKey: p.publicKey,
      sdkUrl: p.sdkUrl,
      ingestUrl: p.ingestUrl,
      configUrl: p.configUrl,
    },
    null,
    0,
  );
  return `<script>window.__LO_CONFIG=${cfg};(function(w,d){w.LandingOptimizer=w.LandingOptimizer||{q:[],track:function(){this.q.push(["track",[].slice.call(arguments)])},conversion:function(){this.q.push(["conversion",[].slice.call(arguments)])},identifyCompanyContext:function(){this.q.push(["identifyCompanyContext",[].slice.call(arguments)])}};var c=w.__LO_CONFIG,s=d.createElement("script");s.async=true;s.src=c.sdkUrl;s.crossOrigin="anonymous";s.setAttribute("data-site-id",c.siteId);s.setAttribute("data-ingest-key",c.ingestKey);s.setAttribute("data-public-key",c.publicKey);s.setAttribute("data-ingest-url",c.ingestUrl);s.setAttribute("data-config-url",c.configUrl);var f=d.getElementsByTagName("script")[0];f&&f.parentNode?f.parentNode.insertBefore(s,f):(d.head||d.documentElement).appendChild(s)})(window,document);</script>`;
}
