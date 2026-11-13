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
import type { FastifyReply } from 'fastify';
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
 * Snapshots are uploaded by authenticated editors from the dashboard.
 */
@Controller()
export class SnapshotsController {
  constructor(private readonly snapshots: SnapshotsService) {}

  @Roles('editor')
  @Post('snapshots')
  @HttpCode(201)
  async ingest(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(SnapshotEnvelopeSchema)) envelope: SnapshotEnvelope,
    @Req() req: RequestContext,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ saved: true } | void> {
    const result = await this.snapshots.ingest(user, envelope);
    if (result === 'ok') return { saved: true };
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
      .header('Cache-Control', 'no-store')
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
