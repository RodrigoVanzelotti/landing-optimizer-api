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
import {
  imageDimensions,
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
 * the behavior heatmap. Uploads require a dashboard editor; every operation
 * checks tenant ownership and serves raster image bytes from Postgres.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async ingest(
    user: AuthUser,
    envelope: SnapshotEnvelope,
  ): Promise<'ok' | 'unauthorized' | 'rate_limited' | 'invalid'> {
    const site = await this.requireSite(user.tenantId, envelope.siteId);
    if (site.status !== 'active') return 'unauthorized';

    const allowed = await this.redis.allow(`rl:snap:${site.id}`, RATE_LIMIT, RATE_WINDOW);
    if (!allowed) return 'rate_limited';

    let image: Buffer;
    try {
      image = Buffer.from(envelope.image, 'base64');
    } catch {
      return 'invalid';
    }
    if (image.length === 0 || image.length > MAX_IMAGE_BYTES) return 'invalid';
    const dimensions = imageDimensions(image, envelope.contentType);
    if (!dimensions || dimensions.some(value => value < 1) || dimensions[0] > envelope.width || dimensions[1] > envelope.height || dimensions[0] * dimensions[1] > 24_000_000) return 'invalid';

    // Unsafe selectors are dropped node-by-node, never stored.
    const nodes: SnapshotNode[] = envelope.nodes.flatMap((n) => {
      const selector = sanitizeSelector(n.selector);
      return selector ? [{ selector, role: n.role, rect: n.rect }] : [];
    });

    const urlPath = sanitizePath(envelope.path);
    await this.prisma.$transaction(async tx => {
      const captured = await tx.pageSnapshot.create({
        data: {
          id: newId(),
          siteId: site.id,
          urlPath,
          width: envelope.width,
          height: envelope.height,
          contentType: envelope.contentType,
          image,
          nodes: nodes as unknown as object,
        },
      });
      await this.audit.log({ tenantId: site.tenantId, actorUserId: user.userId, action: 'snapshot.created', targetType: 'page_snapshot', targetId: captured.id, metadata: { siteId: site.id, source: 'dashboard' } }, tx);
    });
    await this.prune(site.id, urlPath, site.tenantId);

    logger.info('snapshot_stored', {
      site_id: site.id,
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
    await this.prisma.$transaction(async tx => {
      await tx.pageSnapshot.delete({ where: { id: snapshotId } });
      await this.audit.log({
        tenantId: user.tenantId,
        actorUserId: user.userId,
        action: 'snapshot.deleted',
        targetType: 'page_snapshot',
        targetId: snapshotId,
        metadata: { siteId, urlPath: row.urlPath },
      }, tx);
    });
  }

  /** Bound stored bytes: keep the newest N per path and M per site. */
  private async prune(siteId: string, urlPath: string, tenantId: string): Promise<void> {
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
        await this.prisma.$transaction(async tx => {
          const removed = await tx.pageSnapshot.deleteMany({ where: { id: { in: stale } } });
          if (removed.count) await this.audit.log({ tenantId, action: 'snapshot.pruned', targetType: 'site', targetId: siteId, metadata: { snapshotIds: stale, count: removed.count } }, tx);
        });
      }
    } catch {
      // Retention is best-effort; the next successful upload prunes again.
    }
  }

  private async requireSite(tenantId: string, siteId: string) {
    if (!siteId) throw new BadRequestException('siteId is required');
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
    return site;
  }
}
