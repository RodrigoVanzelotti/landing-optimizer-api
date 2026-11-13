import { z } from 'zod';
import { configureLogger, Logger } from '../common/logging/logger';

const logger = Logger('Environment');

/**
 * Environment validation. The app refuses to boot with an invalid config,
 * surfacing misconfiguration early rather than at request time.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'verbose', 'log'])
    .default('info'),

  DATABASE_URL: z.string().url(),

  ANALYTICS_BACKEND: z.enum(['clickhouse', 'postgres']).default('clickhouse'),
  CLICKHOUSE_URL: z.string().url().default('http://localhost:8123'),
  CLICKHOUSE_DB: z.string().default('landing_optimizer'),
  CLICKHOUSE_USER: z.string().default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),

  REDIS_URL: z.string().url().optional(),

  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2592000),

  CONFIG_ENCRYPTION_KEY: z.string().default(''),

  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  AI_SERVICE_TOKEN: z.string().default('dev-internal-token'),

  DASHBOARD_ORIGIN: z.string().default('http://localhost:3000').refine((value) => value.split(',').every((part) => {
    try {
      const origin = new URL(part.trim());
      return ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash;
    } catch { return false; }
  }), 'Expected comma-separated HTTP(S) dashboard origins'),

  CDN_SDK_BASE_URL: z.string().default('https://cdn.landingoptimizer.io/sdk'),
  INGEST_URL: z.string().default('http://localhost:3001/v1/events'),
  CONFIG_URL: z.string().default('http://localhost:3001/v1/config'),
  SDK_VERSION: z.string().default('0.1.0'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  if (env.JWT_SECRET.length < 32 || env.JWT_SECRET === 'dev-secret-change-me-32-bytes-min') ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'Production requires a non-default JWT secret of at least 32 characters' });
  if (!/^[A-Za-z0-9+/]{43}=$/.test(env.CONFIG_ENCRYPTION_KEY) || Buffer.from(env.CONFIG_ENCRYPTION_KEY, 'base64').length !== 32) {
    ctx.addIssue({ code: 'custom', path: ['CONFIG_ENCRYPTION_KEY'], message: 'Production requires a base64-encoded 32-byte encryption key' });
  }
  if (env.AI_SERVICE_TOKEN === 'dev-internal-token' || env.AI_SERVICE_TOKEN.length < 32) ctx.addIssue({ code: 'custom', path: ['AI_SERVICE_TOKEN'], message: 'Production requires a service token of at least 32 characters' });
  if (env.DASHBOARD_ORIGIN.split(',').some(origin => !origin.trim().startsWith('https://'))) ctx.addIssue({ code: 'custom', path: ['DASHBOARD_ORIGIN'], message: 'Production dashboard origins must use HTTPS' });
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error('configuration_invalid', {
      reason: 'validation_error',
      fields: parsed.error.flatten().fieldErrors,
    });
    throw new Error('Invalid environment configuration');
  }
  configureLogger(parsed.data.LOG_LEVEL);
  return parsed.data;
}
