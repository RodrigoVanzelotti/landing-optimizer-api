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

  const dir = join(__dirname, '..', '..', '..', 'clickhouse', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    const statements = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      await client.command({ query: statement });
    }
    await client.insert({
      table: 'schema_migrations',
      values: [{ name: file }],
      format: 'JSONEachRow',
    });
    console.log(`apply ${file}`);
  }

  await client.close();
  console.log('ClickHouse migrations complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
