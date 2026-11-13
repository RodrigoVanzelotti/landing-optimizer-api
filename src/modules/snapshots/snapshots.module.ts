import { Module } from '@nestjs/common';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';

@Module({
  providers: [SnapshotsService],
  controllers: [SnapshotsController],
})
export class SnapshotsModule {}
