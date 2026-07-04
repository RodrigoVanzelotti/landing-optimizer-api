import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth/public.decorator';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health(): { status: string; ts: string } {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
