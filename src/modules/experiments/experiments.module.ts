import { Module } from '@nestjs/common';
import { ExperimentsService } from './experiments.service';
import { ExperimentsController } from './experiments.controller';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [SitesModule],
  providers: [ExperimentsService],
  controllers: [ExperimentsController],
  exports: [ExperimentsService],
})
export class ExperimentsModule {}
