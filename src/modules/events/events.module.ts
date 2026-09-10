import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { SiteAuthService } from './site-auth.service';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [SitesModule],
  providers: [EventsService, SiteAuthService],
  controllers: [EventsController],
  exports: [SiteAuthService],
})
export class EventsModule {}
