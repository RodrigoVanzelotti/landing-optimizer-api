import 'reflect-metadata';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 64 * 1024, // 64 KB — event batches are small; protects memory.
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn', 'log'],
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // API returns JSON only; CSP handled by dashboard/CDN.
  });

  const dashboardOrigin = process.env['DASHBOARD_ORIGIN'] ?? 'http://localhost:3000';
  app.enableCors({
    origin: [dashboardOrigin],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setGlobalPrefix('v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3001);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on :${port}`);
}

void bootstrap();
