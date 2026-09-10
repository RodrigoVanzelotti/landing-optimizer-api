import { Module } from '@nestjs/common';
import { GuardrailsService } from './guardrails.service';
import { GuardrailsController } from './guardrails.controller';

@Module({
  providers: [GuardrailsService],
  controllers: [GuardrailsController],
  exports: [GuardrailsService],
})
export class GuardrailsModule {}
