import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';

@Module({
  imports: [EventsModule],
  providers: [SnapshotsService],
  controllers: [SnapshotsController],
})
export class SnapshotsModule {}
