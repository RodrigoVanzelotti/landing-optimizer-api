import { Module } from '@nestjs/common';
import { JourneyController } from './journey.controller';
import { JourneyService } from './journey.service';

@Module({
  providers: [JourneyService],
  controllers: [JourneyController],
})
export class JourneyModule {}
