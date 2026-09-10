import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { requestIdOf, type RequestContext } from '../../common/logging/request-context';
import { Logger } from '../../common/logging/logger';
import { SnapshotsService } from './snapshots.service';
import { SnapshotEnvelopeSchema, type SnapshotEnvelope } from './snapshots.dto';

const logger = Logger('SnapshotsController');

/**
 * Page snapshot endpoints. `POST /v1/snapshots` is the public upload surface
 * used by the operator-triggered lo-capture bundle (ingest key + origin
 * allowlist + rate limit, mirroring event ingestion). The nested
 * `/sites/:siteId/snapshots` routes are control-plane, JWT authenticated.
 */
@Controller()
export class SnapshotsController {
  constructor(private readonly snapshots: SnapshotsService) {}

  @Public()
  @Post('snapshots')
  @HttpCode(201)
  async ingest(
    @Body(new ZodValidationPipe(SnapshotEnvelopeSchema)) envelope: SnapshotEnvelope,
    @Req() req: RequestContext,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const origin = headerOf(req, 'origin') ?? headerOf(req, 'referer');
    const result = await this.snapshots.ingest(envelope, origin);
    if (result === 'ok') return;
    logger.warn('snapshot_rejected', {
      site_id: envelope.siteId,
      reason: result,
      request_id: requestIdOf(req),
    });
    if (result === 'unauthorized') void res.status(403);
    else if (result === 'rate_limited') void res.status(429);
    else void res.status(400);
  }

  @Get('sites/:siteId/snapshots')
  list(@CurrentUser() user: AuthUser, @Param('siteId') siteId: string) {
    return this.snapshots.list(user.tenantId, siteId);
  }

  @Get('sites/:siteId/snapshots/:snapshotId')
  get(
    @CurrentUser() user: AuthUser,
    @Param('siteId') siteId: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    return this.snapshots.get(user.tenantId, siteId, snapshotId);
  }

  @Get('sites/:siteId/snapshots/:snapshotId/image')
  async image(
    @CurrentUser() user: AuthUser,
    @Param('siteId') siteId: string,
    @Param('snapshotId') snapshotId: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const { contentType, image } = await this.snapshots.image(
      user.tenantId,
      siteId,
      snapshotId,
    );
    void res
      .header('Content-Type', contentType)
      .header('Cache-Control', 'private, max-age=300')
      .send(image);
  }

  @Delete('sites/:siteId/snapshots/:snapshotId')
  @Roles('editor')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('siteId') siteId: string,
    @Param('snapshotId') snapshotId: string,
  ): Promise<void> {
    await this.snapshots.remove(user, siteId, snapshotId);
  }
}

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
