import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import type { AppEnv } from '../../../config/env';
import { safeReason } from '../../../common/logging/request-context';
import { Logger } from '../../../common/logging/logger';

const logger = Logger('ClickHouseService');

/** A single row written to the `events` table (see docs/DATABASE_SCHEMA §2.1). */
export interface EventRow {
  event_time: string; // 'YYYY-MM-DD HH:mm:ss.SSS'
  tenant_id: string;
  site_id: string;
  session_id: string;
  event_name: string;
  page_path: string;
  referrer_host: string;
  device_category: string;
  browser_category: string;
  country: string;
  is_bot: number;
  experiment_id: string;
  variant_id: string;
  section_id: string;
  selector: string;
  goal: string;
  scroll_depth: number;
  dwell_ms: number;
  value: number;
  props: string;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Every column insertEvents writes, kept in sync with EventRow by the type
 * system. Checked against the live schema at boot (verifySchema).
 */
const EVENT_COLUMNS: Record<keyof EventRow, true> = {
  event_time: true,
  tenant_id: true,
  site_id: true,
  session_id: true,
  event_name: true,
  page_path: true,
  referrer_host: true,
  device_category: true,
  browser_category: true,
  country: true,
  is_bot: true,
  experiment_id: true,
  variant_id: true,
  section_id: true,
  selector: true,
  goal: true,
  scroll_depth: true,
  dwell_ms: true,
  value: true,
  props: true,
};

@Injectable()
export class ClickHouseService implements OnModuleInit, OnModuleDestroy {
  private client!: ClickHouseClient;

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  onModuleInit(): void {
    this.client = createClient({
      url: this.config.get('CLICKHOUSE_URL', { infer: true }),
      username: this.config.get('CLICKHOUSE_USER', { infer: true }),
      password: this.config.get('CLICKHOUSE_PASSWORD', { infer: true }),
      database: this.config.get('CLICKHOUSE_DB', { infer: true }),
      clickhouse_settings: {
        // Async inserts smooth out high-frequency ingestion (docs/ARCHITECTURE §5).
        async_insert: 1,
        // Wait for the flush so insert errors surface to the caller and get
        // logged. With 0, ClickHouse acks before parsing and a bad row/schema
        // mismatch discards data with NO error anywhere — untraceable loss.
        // Throughput at scale comes from the edge→queue→consumer path, not
        // from suppressing errors here.
        wait_for_async_insert: 1,
      },
    });
    // Fail loudly (but not fatally) when the running database is missing
    // columns this code writes — the classic "rebuilt the API but did not
    // re-run migrations" incident otherwise looks like silent data loss.
    void this.verifySchema();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  /**
   * Insert event rows. Errors propagate to the caller, which owns the single
   * contextual log record for the incident (single-record rule — logging here
   * too would duplicate it in the shared sink).
   */
  async insertEvents(rows: EventRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.client.insert({
      table: 'events',
      values: rows,
      format: 'JSONEachRow',
    });
  }

  /** Boot-time check that the live schema has every column this code writes. */
  private async verifySchema(): Promise<void> {
    const required = Object.keys(EVENT_COLUMNS);
    try {
      const rows = await this.query<{ name: string }>(
        `SELECT name FROM system.columns
         WHERE database = currentDatabase() AND table = 'events'`,
      );
      const present = new Set(rows.map((r) => r.name));
      const missing = required.filter((c) => !present.has(c));
      if (missing.length > 0) {
        logger.error('clickhouse_schema_outdated', {
          table: 'events',
          missing_columns: missing,
          remedy: 'run npm run clickhouse:migrate (or the compose migrate service)',
        });
      }
    } catch (err) {
      logger.warn('dependency_error', {
        dependency: 'clickhouse',
        operation: 'verify_schema',
        reason: safeReason(err),
      });
    }
  }

  async query<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const result = await this.client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    });
    return result.json<T>();
  }

  get nilUuid(): string {
    return NIL_UUID;
  }

  get raw(): ClickHouseClient {
    return this.client;
  }
}
