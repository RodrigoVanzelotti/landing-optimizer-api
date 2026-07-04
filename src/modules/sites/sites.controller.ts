import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  HttpCode,
} from '@nestjs/common';
import { SitesService } from './sites.service';
import { SiteConfigService } from './site-config.service';
import {
  AddOriginSchema,
  CreateSiteSchema,
  UpdateSiteSchema,
  type AddOriginDto,
  type CreateSiteDto,
  type UpdateSiteDto,
} from './sites.dto';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';

@Controller('sites')
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly siteConfig: SiteConfigService,
  ) {}

  @Post()
  @Roles('editor')
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateSiteSchema)) dto: CreateSiteDto,
  ) {
    return this.sites.create(user.tenantId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.sites.list(user.tenantId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sites.get(user.tenantId, id);
  }

  @Patch(':id')
  @Roles('editor')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSiteSchema)) dto: UpdateSiteDto,
  ) {
    return this.sites.update(user.tenantId, id, dto);
  }

  @Get(':id/snippet')
  snippet(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sites.snippet(user.tenantId, id);
  }

  @Get(':id/origins')
  origins(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sites.listOrigins(user.tenantId, id);
  }

  @Post(':id/origins')
  @Roles('editor')
  @HttpCode(204)
  async addOrigin(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddOriginSchema)) dto: AddOriginDto,
  ): Promise<void> {
    await this.sites.addOrigin(user.tenantId, id, dto);
  }

  @Delete(':id/origins/:originId')
  @Roles('editor')
  @HttpCode(204)
  async removeOrigin(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('originId') originId: string,
  ): Promise<void> {
    await this.sites.removeOrigin(user.tenantId, id, originId);
  }

  @Post(':id/config/publish')
  @Roles('editor')
  async publish(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    // Ownership is enforced by SitesService.get before publishing.
    await this.sites.get(user.tenantId, id);
    return this.siteConfig.publish(id);
  }
}
