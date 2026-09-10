import 'reflect-metadata';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { NestFactory } from '@nestjs/core';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { Logger } from './common/logging/logger';
import { safeReason } from './common/logging/request-context';

const logger = Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    // 6 MB — sized for POST /v1/snapshots (base64 page screenshot, ≤3 MB
    // decoded, enforced in SnapshotsService). Event batches stay tiny and are
    // bounded by EnvelopeSchema; the production edge Worker enforces the
    // 32 KB event-body limit before traffic reaches this API.
    bodyLimit: 6 * 1024 * 1024,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // API returns JSON only; CSP handled by dashboard/CDN.
  });

  const dashboardOrigin = (process.env['DASHBOARD_ORIGIN'] ?? 'http://localhost:3000').split(',');
  app.enableCors({
    origin: dashboardOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setGlobalPrefix('v1', { exclude: ['health'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3001);
  await app.listen(port, '0.0.0.0');
  logger.info('service_started', { host: '0.0.0.0', port });
}

process.on('uncaughtException', (error) => {
  logger.fatal('process_failed', {
    reason: safeReason(error),
    failure: 'uncaught_exception',
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal('process_failed', {
    reason: safeReason(reason),
    failure: 'unhandled_rejection',
  });
  process.exit(1);
});

void bootstrap().catch((error) => {
  logger.fatal('service_start_failed', { reason: safeReason(error) });
  process.exit(1);
});
