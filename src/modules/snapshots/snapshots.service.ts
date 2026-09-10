import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.module';
import { newId } from '../../common/crypto/ids';
import { Logger } from '../../common/logging/logger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.module';
import type { AuthUser } from '../../common/auth/auth.types';
import { sanitizePath, sanitizeSelector } from '../events/event-scrub';
import { SiteAuthService } from '../events/site-auth.service';
import {
  matchesContentType,
  MAX_IMAGE_BYTES,
  type SnapshotEnvelope,
  type SnapshotMeta,
  type SnapshotNode,
} from './snapshots.dto';

const logger = Logger('SnapshotsService');

const RATE_LIMIT = 10; // snapshot uploads per site per window
const RATE_WINDOW = 3600;
const KEEP_PER_PATH = 3; // retained snapshots per (site, path)
const KEEP_PER_SITE = 20; // retained snapshots per site overall

/**
 * Stores operator-captured page snapshots (screenshot + element geometry) for
 * the behavior heatmap. Upload uses the same public trust model as event
 * ingestion (ingest key + origin allowlist + rate limit); reads are
 * control-plane, tenant-scoped, and serve the image bytes from Postgres.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly siteAuth: SiteAuthService,
    private readonly audit: AuditService,
  ) {}

  async ingest(
    envelope: SnapshotEnvelope,
    origin: string | undefined,
  ): Promise<'ok' | 'unauthorized' | 'rate_limited' | 'invalid'> {
    const site = await this.siteAuth.resolveSite(envelope.siteId, envelope.ik);
    if (!site || !site.active) return 'unauthorized';
    if (!this.siteAuth.originAllowed(site, origin)) return 'unauthorized';

    const allowed = await this.redis.allow(`rl:snap:${site.siteId}`, RATE_LIMIT, RATE_WINDOW);
    if (!allowed) return 'rate_limited';

    let image: Buffer;
    try {
      image = Buffer.from(envelope.image, 'base64');
    } catch {
      return 'invalid';
    }
    if (image.length === 0 || image.length > MAX_IMAGE_BYTES) return 'invalid';
    if (!matchesContentType(image, envelope.contentType)) return 'invalid';

    // Unsafe selectors are dropped node-by-node, never stored.
    const nodes: SnapshotNode[] = envelope.nodes.flatMap((n) => {
      const selector = sanitizeSelector(n.selector);
      return selector ? [{ selector, role: n.role, rect: n.rect }] : [];
    });

    const urlPath = sanitizePath(envelope.path);
    await this.prisma.pageSnapshot.create({
      data: {
        id: newId(),
        siteId: site.siteId,
        urlPath,
        width: envelope.width,
        height: envelope.height,
        contentType: envelope.contentType,
        image,
        nodes: nodes as unknown as object,
      },
    });
    await this.prune(site.siteId, urlPath);

    logger.info('snapshot_stored', {
      site_id: site.siteId,
      path: urlPath,
      bytes: image.length,
      nodes: nodes.length,
    });
    return 'ok';
  }

  async list(tenantId: string, siteId: string): Promise<SnapshotMeta[]> {
    await this.requireSite(tenantId, siteId);
    const rows = await this.prisma.pageSnapshot.findMany({
      where: { siteId },
      orderBy: { capturedAt: 'desc' },
      select: {
        id: true,
        urlPath: true,
        width: true,
        height: true,
        contentType: true,
        nodes: true,
        capturedAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      urlPath: r.urlPath,
      width: r.width,
      height: r.height,
      contentType: r.contentType,
      nodeCount: Array.isArray(r.nodes) ? r.nodes.length : 0,
      capturedAt: r.capturedAt.toISOString(),
    }));
  }

  /** Full snapshot detail: metadata + element geometry (no image bytes). */
  async get(
    tenantId: string,
    siteId: string,
    snapshotId: string,
  ): Promise<SnapshotMeta & { nodes: SnapshotNode[] }> {
    await this.requireSite(tenantId, siteId);
    const row = await this.prisma.pageSnapshot.findUnique({
      where: { id: snapshotId },
      select: {
        id: true,
        siteId: true,
        urlPath: true,
        width: true,
        height: true,
        contentType: true,
        nodes: true,
        capturedAt: true,
      },
    });
    if (!row || row.siteId !== siteId) throw new NotFoundException('Snapshot not found');
    const nodes = Array.isArray(row.nodes) ? (row.nodes as unknown as SnapshotNode[]) : [];
    return {
      id: row.id,
      urlPath: row.urlPath,
      width: row.width,
      height: row.height,
      contentType: row.contentType,
      nodeCount: nodes.length,
      capturedAt: row.capturedAt.toISOString(),
      nodes,
    };
  }

  async image(
    tenantId: string,
    siteId: string,
    snapshotId: string,
  ): Promise<{ contentType: string; image: Buffer }> {
    await this.requireSite(tenantId, siteId);
    const row = await this.prisma.pageSnapshot.findUnique({
      where: { id: snapshotId },
      select: { siteId: true, contentType: true, image: true },
    });
    if (!row || row.siteId !== siteId) throw new NotFoundException('Snapshot not found');
    return { contentType: row.contentType, image: Buffer.from(row.image) };
  }

  async remove(user: AuthUser, siteId: string, snapshotId: string): Promise<void> {
    await this.requireSite(user.tenantId, siteId);
    const row = await this.prisma.pageSnapshot.findUnique({
      where: { id: snapshotId },
      select: { siteId: true, urlPath: true },
    });
    if (!row || row.siteId !== siteId) throw new NotFoundException('Snapshot not found');
    await this.prisma.pageSnapshot.delete({ where: { id: snapshotId } });
    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action: 'snapshot.deleted',
      targetType: 'page_snapshot',
      targetId: snapshotId,
      metadata: { siteId, urlPath: row.urlPath },
    });
  }

  /** Bound stored bytes: keep the newest N per path and M per site. */
  private async prune(siteId: string, urlPath: string): Promise<void> {
    try {
      const perPath = await this.prisma.pageSnapshot.findMany({
        where: { siteId, urlPath },
        orderBy: { capturedAt: 'desc' },
        select: { id: true },
        skip: KEEP_PER_PATH,
      });
      const perSite = await this.prisma.pageSnapshot.findMany({
        where: { siteId },
        orderBy: { capturedAt: 'desc' },
        select: { id: true },
        skip: KEEP_PER_SITE,
      });
      const stale = [...new Set([...perPath, ...perSite].map((r) => r.id))];
      if (stale.length > 0) {
        await this.prisma.pageSnapshot.deleteMany({ where: { id: { in: stale } } });
      }
    } catch {
      // Retention is best-effort; the next successful upload prunes again.
    }
  }

  private async requireSite(tenantId: string, siteId: string): Promise<void> {
    if (!siteId) throw new BadRequestException('siteId is required');
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
  }
}
