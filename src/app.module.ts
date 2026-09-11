import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { validateEnv } from './config/env';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuditModule } from './common/audit/audit.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { TransactionLoggingInterceptor } from './common/logging/transaction-logging.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { SitesModule } from './modules/sites/sites.module';
import { GoalsModule } from './modules/goals/goals.module';
import { GuardrailsModule } from './modules/guardrails/guardrails.module';
import { ExperimentsModule } from './modules/experiments/experiments.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { EventsModule } from './modules/events/events.module';
import { SnapshotsModule } from './modules/snapshots/snapshots.module';
import { JourneyModule } from './modules/journey/journey.module';
import { AiModule } from './modules/ai/ai.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AuditReadModule } from './modules/audit/audit.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    // Global infrastructure
    PrismaModule,
    RedisModule,
    CryptoModule,
    AuditModule,
    AnalyticsModule,
    // Feature modules
    AuthModule,
    SitesModule,
    GoalsModule,
    GuardrailsModule,
    ExperimentsModule,
    EventsModule,
    SnapshotsModule,
    JourneyModule,
    AiModule,
    ApprovalsModule,
    AuditReadModule,
  ],
  controllers: [HealthController],
  providers: [
    // Authenticate every route by default; opt out with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Enforce @Roles() after authentication.
    { provide: APP_GUARD, useClass: RolesGuard },
    // Log successful control-plane mutations once, with request correlation.
    { provide: APP_INTERCEPTOR, useClass: TransactionLoggingInterceptor },
  ],
})
export class AppModule {}
