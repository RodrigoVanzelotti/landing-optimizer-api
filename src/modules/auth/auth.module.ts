import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import type { AppEnv } from '../../config/env';
import { TeamModule } from '../team/team.module';
import { PasswordResetService } from './password-reset.service';
import { AuthBoundaryGuard } from './auth-boundary.guard';

@Module({
  imports: [
    TeamModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordResetService, AuthBoundaryGuard],
  exports: [AuthService, JwtModule, PasswordResetService],
})
export class AuthModule {}
