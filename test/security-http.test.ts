import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHttpAdapter } from '../src/http-adapter';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/common/redis/redis.module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { PasswordResetService } from '../src/modules/auth/password-reset.service';
import { AuthBoundaryGuard } from '../src/modules/auth/auth-boundary.guard';
import { JwtAuthGuard } from '../src/common/auth/jwt-auth.guard';
import { RolesGuard } from '../src/common/auth/roles.guard';
import { ControlPlaneRateGuard } from '../src/common/auth/control-plane-rate.guard';
import { SnapshotsController } from '../src/modules/snapshots/snapshots.controller';
import { SnapshotsService } from '../src/modules/snapshots/snapshots.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

const siteId = '11111111-1111-4111-8111-111111111111';
const otherSiteId = '22222222-2222-4222-8222-222222222222';
const state = { role: 'editor', version: 0 };
const jwt = new JwtService({ secret: 'http-security-test-secret', verifyOptions: { algorithms: ['HS256'] } });
const redis = { allow: vi.fn().mockResolvedValue(true) };
const config = { get: (key: string) => ({ DASHBOARD_ORIGIN: 'https://dashboard.example', JWT_ACCESS_TTL: 900, JWT_REFRESH_TTL: 3600 })[key] };
const prisma = {
  userMembership: { findUnique: vi.fn(async () => ({ role: state.role, user: { email: 'editor@example.com', sessionVersion: state.version }, tenant: { archivedAt: null } })) },
  user: { updateMany: vi.fn(async ({ where }: { where: { sessionVersion: number } }) => ({ count: where.sessionVersion === state.version ? (++state.version, 1) : 0 })) },
  site: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, tenantId: where.id === siteId ? 'tenant' : 'other-tenant', status: 'active' })) },
  pageSnapshot: { create: vi.fn().mockResolvedValue({ id: 'snapshot' }), findMany: vi.fn().mockResolvedValue([]) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
};
const auth = new AuthService(prisma as never, jwt, config as never, {} as never);
const snapshots = new SnapshotsService(prisma as never, redis as never, { log: vi.fn() } as never);
const reflector = new Reflector();
Reflect.defineMetadata('design:paramtypes', [AuthService, PasswordResetService], AuthController);
Reflect.defineMetadata('design:paramtypes', [SnapshotsService], SnapshotsController);

@Module({
  controllers: [AuthController, SnapshotsController],
  providers: [
    { provide: ConfigService, useValue: config },
    { provide: RedisService, useValue: redis },
    { provide: AuthService, useValue: auth },
    { provide: PasswordResetService, useValue: {} },
    { provide: SnapshotsService, useValue: snapshots },
    { provide: AuthBoundaryGuard, useValue: new AuthBoundaryGuard(config as never, redis as never) },
    { provide: APP_GUARD, useValue: new JwtAuthGuard(jwt, reflector, prisma as never) },
    { provide: APP_GUARD, useValue: new RolesGuard(reflector) },
    { provide: APP_GUARD, useValue: new ControlPlaneRateGuard(redis as never) },
  ],
})
class TestModule {}

const token = (extra = {}) => jwt.sign({ sub: 'editor', tid: 'tenant', sv: state.version, ...extra }, { expiresIn: 900 });
const payload = () => ({ v: 1, siteId, path: '/', width: 800, height: 600, contentType: 'image/png', image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM/8AAAAASUVORK5CYII=', nodes: [] });

describe('HTTP security boundaries with real global guards', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(TestModule, createHttpAdapter(), { logger: false, abortOnError: false });
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => { state.role = 'editor'; state.version = 0; vi.clearAllMocks(); });
  afterAll(async () => { await app?.close(); });

  it('rejects public-key uploads and refresh tokens presented as access tokens', async () => {
    for (const headers of [{}, { authorization: `Bearer ${token({ typ: 'refresh' })}` }]) {
      expect((await app.inject({ method: 'POST', url: '/v1/snapshots', headers, payload: { ...payload(), ik: 'public-key' } })).statusCode).toBe(401);
    }
    expect(prisma.pageSnapshot.create).not.toHaveBeenCalled();
  });

  it('denies viewers and foreign-tenant uploads before writing anything', async () => {
    const authorization = `Bearer ${token()}`;
    state.role = 'viewer';
    expect((await app.inject({ method: 'POST', url: '/v1/snapshots', headers: { authorization }, payload: payload() })).statusCode).toBe(403);
    state.role = 'editor';
    expect((await app.inject({ method: 'POST', url: '/v1/snapshots', headers: { authorization }, payload: { ...payload(), siteId: otherSiteId } })).statusCode).toBe(403);
    expect(prisma.pageSnapshot.create).not.toHaveBeenCalled();
  });

  it('accepts a valid editor upload for the current tenant without an ingest key', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/snapshots', headers: { authorization: `Bearer ${token()}` }, payload: payload() })).statusCode).toBe(201);
    expect(prisma.pageSnapshot.create).toHaveBeenCalledOnce();
  });

  it('rejects decoded dimensions that exceed the declared image or pixel budget', async () => {
    for (const [width, height, declaredWidth, declaredHeight] of [[900, 600, 800, 600], [4000, 40000, 4000, 40000]]) {
      const image = Buffer.from(payload().image, 'base64');
      image.writeUInt32BE(width!, 16); image.writeUInt32BE(height!, 20);
      expect((await app.inject({ method: 'POST', url: '/v1/snapshots', headers: { authorization: `Bearer ${token()}` }, payload: { ...payload(), width: declaredWidth, height: declaredHeight, image: image.toString('base64') } })).statusCode).toBe(400);
    }
    expect(prisma.pageSnapshot.create).not.toHaveBeenCalled();
  });

  it('revokes old access and refresh tokens for every device on logout', async () => {
    const access = token();
    const refresh = token({ typ: 'refresh' });
    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${access}`, origin: 'https://dashboard.example' } });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${access}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: `__Host-lo_refresh=${refresh}` } })).statusCode).toBe(401);
  });

  it('rejects an untrusted browser origin before refreshing a cookie', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { origin: 'https://evil.example', cookie: `__Host-lo_refresh=${token({ typ: 'refresh' })}` } })).statusCode).toBe(403);
  });

  it('applies production body limits before auth work and prevents private response caching', async () => {
    const oversized = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'test@example.com', password: 'password', padding: 'x'.repeat(16 * 1024) } });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me' })).headers['cache-control']).toBe('no-store');
  });
});
