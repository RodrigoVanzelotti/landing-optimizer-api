/**
 * Idempotent ClickHouse migration runner. Reads *.sql files from
 * clickhouse/migrations in order, splits on `;`, and executes each statement.
 * Tracks applied files in a `schema_migrations` table.
 *
 * Usage: `npm run clickhouse:migrate`
 */
import { createClient } from '@clickhouse/client';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../../../common/logging/logger';
import { safeReason } from '../../../common/logging/request-context';

const logger = Logger('ClickHouseMigration');

async function main(): Promise<void> {
  const database = process.env['CLICKHOUSE_DB'] ?? 'landing_optimizer';
  const url = process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';

  // Ensure the database exists using a connection without a default DB.
  const bootstrap = createClient({
    url,
    username: process.env['CLICKHOUSE_USER'] ?? 'default',
    password: process.env['CLICKHOUSE_PASSWORD'] ?? '',
  });
  await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  await bootstrap.close();

  const client = createClient({
    url,
    username: process.env['CLICKHOUSE_USER'] ?? 'default',
    password: process.env['CLICKHOUSE_PASSWORD'] ?? '',
    database,
  });

  await client.command({
    query: `CREATE TABLE IF NOT EXISTS schema_migrations (
      name String, applied_at DateTime DEFAULT now()
    ) ENGINE = MergeTree ORDER BY name`,
  });

  const applied = new Set(
    (
      await (
        await client.query({ query: 'SELECT name FROM schema_migrations', format: 'JSONEachRow' })
      ).json<{ name: string }>()
    ).map((r) => r.name),
  );

  const dir = join(__dirname, '..', '..', '..', '..', 'clickhouse', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      logger.info('migration_skipped', { database: 'clickhouse', migration: file });
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    const statements = sql
      .split(/;\s*$/m)
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim()
      )
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await client.command({ query: statement });
    }
    await client.insert({
      table: 'schema_migrations',
      values: [{ name: file }],
      format: 'JSONEachRow',
    });
    logger.info('migration_applied', { database: 'clickhouse', migration: file });
  }

  await client.close();
  logger.info('migration_completed', { database: 'clickhouse', migrations: files.length });
}

main().catch((err) => {
  logger.error('migration_failed', { database: 'clickhouse', reason: safeReason(err) });
  process.exit(1);
});
