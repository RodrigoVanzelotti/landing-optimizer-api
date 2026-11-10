import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Public } from './common/auth/public.decorator';

@Controller('sdk')
export class SdkController {
  @Public()
  @Get('v0.1.0/:file')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  async bundle(@Param('file') file: string): Promise<string> {
    if (!['lo.js', 'loader.js', 'lo-capture.js'].includes(file)) throw new NotFoundException();
    return readFile(join(process.cwd(), 'sdk', file), 'utf8');
  }
}
