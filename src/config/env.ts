import { z } from 'zod';

/**
 * Environment validation. The app refuses to boot with an invalid config,
 * surfacing misconfiguration early rather than at request time.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().url(),

  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_DB: z.string().default('landing_optimizer'),
  CLICKHOUSE_USER: z.string().default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),

  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1209600),

  CONFIG_ENCRYPTION_KEY: z.string().default(''),

  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  AI_SERVICE_TOKEN: z.string().default('dev-internal-token'),

  DASHBOARD_ORIGIN: z.string().default('http://localhost:3000'),

  CDN_SDK_BASE_URL: z.string().default('https://cdn.landingoptimizer.io/sdk'),
  INGEST_URL: z.string().default('http://localhost:3001/v1/events'),
  CONFIG_URL: z.string().default('http://localhost:3001/v1/config'),
  SDK_VERSION: z.string().default('0.1.0'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  return parsed.data;
}
