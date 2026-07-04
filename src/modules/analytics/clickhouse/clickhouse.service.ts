import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import type { AppEnv } from '../../../config/env';

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
  scroll_depth: number;
  dwell_ms: number;
  value: number;
  props: string;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class ClickHouseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClickHouseService.name);
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
        wait_for_async_insert: 0,
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  async insertEvents(rows: EventRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.client.insert({
        table: 'events',
        values: rows,
        format: 'JSONEachRow',
      });
    } catch (err) {
      this.logger.error(`ClickHouse insert failed: ${(err as Error).message}`);
      throw err;
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
