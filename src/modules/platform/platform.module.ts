import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { AuthModule } from '../auth/auth.module';
import { PlatformOwnerGuard } from '../../common/auth/platform-owner.guard';

@Module({ imports: [AuthModule], controllers: [PlatformController], providers: [PlatformService, PlatformOwnerGuard] })
export class PlatformModule {}
