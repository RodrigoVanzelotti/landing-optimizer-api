import { Global, Module } from '@nestjs/common';
import { ClickHouseService } from './clickhouse/clickhouse.service';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Global()
@Module({
  providers: [ClickHouseService, AnalyticsService],
  controllers: [AnalyticsController],
  exports: [ClickHouseService, AnalyticsService],
})
export class AnalyticsModule {}
