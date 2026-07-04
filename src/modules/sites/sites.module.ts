import { Module } from '@nestjs/common';
import { SitesService } from './sites.service';
import { SitesController } from './sites.controller';
import { SiteConfigService } from './site-config.service';

@Module({
  providers: [SitesService, SiteConfigService],
  controllers: [SitesController],
  exports: [SitesService, SiteConfigService],
})
export class SitesModule {}
