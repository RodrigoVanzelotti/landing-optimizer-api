import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [SitesModule],
  providers: [EventsService],
  controllers: [EventsController],
})
export class EventsModule {}
