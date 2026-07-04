import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import {
  LoginSchema,
  RegisterSchema,
  type LoginDto,
  type RegisterDto,
} from './auth.dto';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { Public } from '../../common/auth/public.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import type { AppEnv } from '../../config/env';

const REFRESH_COOKIE = '__Host-lo_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(RegisterSchema)) dto: RegisterDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ accessToken: string; user: unknown }> {
    const result = await this.auth.register(dto.email, dto.password, dto.tenantName, dto.name);
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ accessToken: string; user: unknown }> {
    const result = await this.auth.login(dto.email, dto.password);
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ accessToken: string }> {
    const token = readCookie(req, REFRESH_COOKIE);
    const result = await this.auth.refresh(token ?? '');
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: FastifyReply): void {
    void res.header(
      'set-cookie',
      `${REFRESH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    );
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.auth.me(user);
  }

  private setRefreshCookie(res: FastifyReply, token: string): void {
    const maxAge = this.config.get('JWT_REFRESH_TTL', { infer: true });
    void res.header(
      'set-cookie',
      `${REFRESH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
    );
  }
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers['cookie'];
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
