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
import { AuthService, type AuthResult } from './auth.service';
import {
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema,
  type LoginDto,
  type RegisterDto,
} from './auth.dto';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { Public } from '../../common/auth/public.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { PasswordResetService } from './password-reset.service';

const REFRESH_COOKIE = '__Host-lo_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwords: PasswordResetService,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(RegisterSchema)) dto: RegisterDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ accessToken: string; user: unknown }> {
    const result = await this.auth.register(dto.token, dto.email, dto.name, dto.password);
    this.setRefreshCookie(res, result);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordSchema)) dto: { token: string; password: string },
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    await this.passwords.complete(dto.token, dto.password);
    this.clearRefreshCookie(res);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ accessToken: string; user: unknown }> {
    const result = await this.auth.login(dto.email, dto.password, dto.rememberMe);
    this.setRefreshCookie(res, result);
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
    this.setRefreshCookie(res, result);
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Res({ passthrough: true }) res: FastifyReply, @CurrentUser() user: AuthUser): Promise<void> {
    try { await this.auth.logout(user); }
    finally { this.clearRefreshCookie(res); }
  }

  private clearRefreshCookie(res: FastifyReply): void {
    void res.header(
      'set-cookie',
      `${REFRESH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    );
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.auth.me(user);
  }

  private setRefreshCookie(res: FastifyReply, result: AuthResult): void {
    const maxAge = Math.max(0, result.refreshExpiresAt - Math.floor(Date.now() / 1000));
    void res.header(
      'set-cookie',
      `${REFRESH_COOKIE}=${result.refreshToken}; Path=/; HttpOnly; Secure; SameSite=Strict${result.rememberMe ? `; Max-Age=${maxAge}` : ''}`,
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
