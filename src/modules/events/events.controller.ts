import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { EventsService } from './events.service';
import { EnvelopeSchema } from './event-scrub';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { Public } from '../../common/auth/public.decorator';
import { SiteConfigService } from '../sites/site-config.service';
import type { Envelope } from './event-scrub';

/**
 * Public edge surface consumed by the snippet. No authentication — protected by
 * ingest-key + origin allowlist + rate limiting. Always responds fast so the
 * host page is never blocked.
 */
@Controller()
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly siteConfig: SiteConfigService,
  ) {}

  @Public()
  @Post('events')
  @HttpCode(202)
  async ingest(
    @Body(new ZodValidationPipe(EnvelopeSchema)) envelope: Envelope,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const origin = headerOf(req, 'origin') ?? headerOf(req, 'referer');
    const ip = clientIp(req);
    const result = await this.events.ingest(envelope, origin, ip);
    if (result === 'unauthorized') void res.status(403);
    else if (result === 'rate_limited') void res.status(429);
    // 'ok' keeps the 202 default.
  }

  @Public()
  @Get('config/:siteId')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300')
  async config(
    @Param('siteId') siteId: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<unknown> {
    const config = await this.siteConfig.get(siteId);
    if (!config) {
      void res.status(404);
      return { error: { code: 'not_found', message: 'Unknown site' } };
    }
    return config;
  }
}

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function clientIp(req: FastifyRequest): string | undefined {
  const fwd = headerOf(req, 'x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim();
  return req.ip;
}
