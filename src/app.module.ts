import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuditModule } from './common/audit/audit.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { AuthModule } from './modules/auth/auth.module';
import { SitesModule } from './modules/sites/sites.module';
import { ExperimentsModule } from './modules/experiments/experiments.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { EventsModule } from './modules/events/events.module';
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
    ExperimentsModule,
    EventsModule,
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
  ],
})
export class AppModule {}
