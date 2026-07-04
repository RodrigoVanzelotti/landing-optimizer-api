import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { AiClient } from './ai.client';

@Module({
  providers: [AiService, AiClient],
  controllers: [AiController],
  exports: [AiService],
})
export class AiModule {}
