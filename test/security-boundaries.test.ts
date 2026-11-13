import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AuthBoundaryGuard } from '../src/modules/auth/auth-boundary.guard';
import { SiteAuthService } from '../src/modules/events/site-auth.service';
import { ApprovalsService } from '../src/modules/approvals/approvals.module';
import { AddOriginSchema } from '../src/modules/sites/sites.dto';
import { validateEnv } from '../src/config/env';
import { RedisService } from '../src/common/redis/redis.module';
import { AiClient } from '../src/modules/ai/ai.client';
import { ControlPlaneRateGuard } from '../src/common/auth/control-plane-rate.guard';
import { ExperimentsService } from '../src/modules/experiments/experiments.service';
import { Prisma } from '@prisma/client';
import { SiteConfigService } from '../src/modules/sites/site-config.service';
import { AnalyticsRangeQuerySchema } from '../src/modules/analytics/report';
import { ExperimentQuerySchema } from '../src/modules/experiments/experiments.dto';
import { ApprovalQuerySchema } from '../src/modules/approvals/approvals.module';

afterEach(() => { vi.restoreAllMocks(); });

it('limits authenticated traffic and AI spending without applying the user quota to public requests', async () => {
  const allow = vi.fn().mockResolvedValue(true);
  const guard = new ControlPlaneRateGuard({ allow } as never);
  const request = { user: undefined as { userId: string } | undefined, method: 'POST', url: '/v1/sites/site/ai/analyze' };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;
  expect(await guard.canActivate(context)).toBe(true);
  expect(allow).not.toHaveBeenCalled();
  request.user = { userId: 'user' };
  expect(await guard.canActivate(context)).toBe(true);
  expect(allow.mock.calls).toEqual([['rl:control:user', 300, 60], ['rl:ai:user', 5, 60]]);
  allow.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
  request.url = '/v1/auth/logout';
  allow.mockClear().mockResolvedValue(false);
  expect(await guard.canActivate(context)).toBe(true);
  expect(allow).not.toHaveBeenCalled();
});

it('rejects state changes based on a stale experiment and rejects a foreign winner', async () => {
  const experiment = { id: 'experiment', tenantId: 'tenant', siteId: 'site', status: 'running', updatedAt: new Date() };
  const update = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('No matching record', { code: 'P2025', clientVersion: 'test' }));
  const prisma = { experiment: { findUnique: vi.fn().mockResolvedValue(experiment), update }, variant: { findFirst: vi.fn().mockResolvedValue(null) }, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) };
  const publish = vi.fn();
  const audit = vi.fn();
  const service = new ExperimentsService(prisma as never, { publish } as never, { log: audit } as never);
  const user = { userId: 'editor', tenantId: 'tenant', role: 'editor', email: 'editor@example.com' } as const;
  await expect(service.pause(user, experiment.id)).rejects.toMatchObject({ status: 409 });
  expect(update).toHaveBeenCalledWith({ where: { id: experiment.id, tenantId: 'tenant', status: 'running', updatedAt: experiment.updatedAt }, data: { status: 'paused' } });
  expect(publish).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
  await expect(service.complete(user, experiment.id, { winnerVariantId: 'foreign-variant' })).rejects.toMatchObject({ status: 400 });
});

it('invalidates live config in the state-change transaction even if publication fails', async () => {
  const siteUpdate = vi.fn();
  const experiment = { id: 'experiment', tenantId: 'tenant', siteId: 'site', status: 'running', updatedAt: new Date() };
  const prisma = { experiment: { findUnique: vi.fn().mockResolvedValue(experiment), update: vi.fn().mockResolvedValue({ ...experiment, status: 'paused' }) }, site: { update: siteUpdate }, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) };
  const service = new ExperimentsService(prisma as never, { publish: vi.fn().mockRejectedValue(new Error('publisher unavailable')) } as never, { log: vi.fn() } as never);
  await expect(service.pause({ userId: 'editor', tenantId: 'tenant', role: 'editor', email: 'editor@example.com' }, 'experiment')).rejects.toThrow('publisher unavailable');
  expect(siteUpdate).toHaveBeenCalledWith({ where: { id: 'site' }, data: { configVersion: { increment: 1 } } });
});

it('rebuilds an outdated signed config without a public GET mutating the database', async () => {
  const site = { id: 'site', tenantId: 'tenant', status: 'active', configVersion: 4, samplingRate: 1, privateKeyEnc: Buffer.from('key'), tenant: { archivedAt: null } };
  const prisma = { site: { findUnique: vi.fn().mockResolvedValue(site), update: vi.fn() }, experiment: { findMany: vi.fn().mockResolvedValue([]) }, $transaction: vi.fn() };
  const redis = { get: vi.fn().mockResolvedValue(JSON.stringify({ siteId: 'site', version: 3, experiments: [{ id: 'stale-running-experiment' }] })), set: vi.fn() };
  const service = new SiteConfigService(prisma as never, redis as never, { signConfig: () => 'signature' } as never);
  expect(await service.get('site')).toMatchObject({ version: 4, experiments: [], sig: 'signature' });
  expect(prisma.site.update).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('validates analytics ranges and enum filters before they reach storage', () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  expect(AnalyticsRangeQuerySchema.parse({ siteId }).from).toMatch(/^\d{4}-/);
  for (const patch of [{ from: 'bad' }, { from: ['2026-01-01'] }, { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, { from: '2000-01-01T00:00:00Z' }, { siteId: ['site'] }, { path: '/'.repeat(513) }]) expect(AnalyticsRangeQuerySchema.safeParse({ siteId, ...patch }).success).toBe(false);
  expect(ExperimentQuerySchema.safeParse({ status: 'invalid' }).success).toBe(false);
  expect(ApprovalQuerySchema.safeParse({ status: ['approved'] }).success).toBe(false);
});

function authRequest(action = 'login', overrides = {}) {
  const request = { method: 'POST', headers: { origin: 'https://dashboard.example' }, socket: { remoteAddress: '127.0.0.1' }, body: { email: ' Ana@Example.com ' }, ...overrides };
  const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => ({ name: action }) };
  const allow = vi.fn().mockResolvedValue(true);
  const guard = new AuthBoundaryGuard({ get: () => 'https://dashboard.example' } as never, { allow } as never);
  return { guard, context: context as never, allow };
}

describe('authentication boundary', () => {
  it('normalizes configured origins with trailing slashes and default ports', async () => {
    const { context, allow } = authRequest();
    const guard = new AuthBoundaryGuard({ get: () => 'https://dashboard.example:443/, https://other.example/' } as never, { allow } as never);
    expect(await guard.canActivate(context)).toBe(true);
  });
  it('rejects foreign and opaque origins before doing authentication work', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const { guard, context, allow } = authRequest('login', { headers: { origin } });
      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
      expect(allow).not.toHaveBeenCalled();
    }
  });

  it('rejects cross-site fetch metadata, while supporting non-browser clients', async () => {
    const cross = authRequest('refresh', { headers: { 'sec-fetch-site': 'cross-site' } });
    await expect(cross.guard.canActivate(cross.context)).rejects.toMatchObject({ status: 403 });
    const cli = authRequest('refresh', { headers: {} });
    expect(await cli.guard.canActivate(cli.context)).toBe(true);
  });

  it('uses a normalized hashed account and socket peer, ignoring forged forwarding headers', async () => {
    const first = authRequest();
    const second = authRequest('login', { headers: { 'x-forwarded-for': 'attacker-controlled' }, body: { email: 'ana@example.com' } });
    await first.guard.canActivate(first.context);
    await second.guard.canActivate(second.context);
    expect(first.allow.mock.calls).toEqual(second.allow.mock.calls);
    expect(first.allow.mock.calls[1]).toEqual([expect.stringMatching(/^rl:login:[a-f0-9]{64}$/), 10, 900]);
    expect(JSON.stringify(first.allow.mock.calls)).not.toContain('ana@example.com');
  });

  it('rejects exhausted source and account limits and propagates limiter outages', async () => {
    const source = authRequest();
    source.allow.mockResolvedValue(false);
    await expect(source.guard.canActivate(source.context)).rejects.toMatchObject({ status: 429 });
    const account = authRequest();
    account.allow.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(account.guard.canActivate(account.context)).rejects.toMatchObject({ status: 429 });
    const outage = authRequest();
    outage.allow.mockRejectedValue(new Error('database unavailable'));
    await expect(outage.guard.canActivate(outage.context)).rejects.toThrow('database unavailable');
  });
});

describe('site permissions and origins', () => {
  it('derives daily pseudonyms from a server secret and separates sites', () => {
    const first = new SiteAuthService({} as never, { get: () => 'secret-one' } as never);
    const second = new SiteAuthService({} as never, { get: () => 'secret-two' } as never);
    expect(first.dailySalt()).not.toBe(second.dailySalt());
    expect(first.pseudoSession('session', 'site-a')).not.toBe(first.pseudoSession('session', 'site-b'));
    expect(first.pseudoSession('session', 'site-a')).toBe(first.pseudoSession('session', 'site-a'));
  });
  it('denies empty, absent, malformed and different origins', () => {
    const service = new SiteAuthService({} as never, {} as never);
    const site = { siteId: 'site', tenantId: 'tenant', active: true, origins: ['https://customer.example'] };
    for (const origin of [undefined, 'null', 'https://evil.example', 'https://customer.example.evil']) expect(service.originAllowed(site, origin)).toBe(false);
    expect(service.originAllowed({ ...site, origins: [] }, 'https://customer.example')).toBe(false);
    expect(service.originAllowed(site, 'https://customer.example/path')).toBe(true);
  });

  it('immediately reflects pause, origin removal and ingest-key changes', async () => {
    const site = { id: 'site', tenantId: 'tenant', ingestKey: 'key', status: 'active', origins: [{ origin: 'https://customer.example' }], tenant: { archivedAt: null } };
    const service = new SiteAuthService({ site: { findUnique: vi.fn().mockResolvedValue(site) } } as never, {} as never);
    expect(await service.resolveSite('site', 'key')).toMatchObject({ active: true });
    site.status = 'paused'; site.origins = [];
    expect(await service.resolveSite('site', 'key')).toMatchObject({ active: false, origins: [] });
    site.ingestKey = 'new-key';
    expect(await service.resolveSite('site', 'key')).toBeNull();
  });

  it('accepts only bare HTTP(S) allowlist entries', () => {
    for (const origin of ['ftp://customer.example', 'https://user:pass@customer.example', 'https://customer.example?token=secret', 'https://customer.example#hash', 'https://customer.example/path']) expect(AddOriginSchema.safeParse({ origin }).success).toBe(false);
    expect(AddOriginSchema.safeParse({ origin: 'https://customer.example:8443' }).success).toBe(true);
  });
});

it('projects only safe site fields in the approvals response', async () => {
  const findMany = vi.fn().mockResolvedValue([]);
  await new ApprovalsService({ approval: { findMany } } as never).listQueue('tenant');
  expect(findMany.mock.calls[0][0]).toMatchObject({ where: { experiment: { tenantId: 'tenant' } }, include: { experiment: { include: { site: { select: { id: true, name: true, primaryDomain: true } } } } } });
});

it('falls back to shared PostgreSQL limits on a Redis outage', async () => {
  const prisma = { $executeRaw: vi.fn().mockResolvedValue(0), $queryRaw: vi.fn().mockResolvedValue([{ count: 11 }]) };
  const service = new RedisService(new ConfigService({}), prisma as never);
  Object.assign(service, { client: { eval: vi.fn().mockRejectedValue(new Error('Redis unavailable')) } });
  expect(await service.allow('account', 10, 900)).toBe(false);
  prisma.$queryRaw.mockRejectedValue(new Error('PostgreSQL unavailable'));
  await expect(service.allow('account', 10, 900)).rejects.toThrow('PostgreSQL unavailable');
});

describe('production secrets', () => {
  const production = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/test', JWT_SECRET: 'j'.repeat(32), CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), AI_SERVICE_TOKEN: 'a'.repeat(32), DASHBOARD_ORIGIN: 'https://dashboard.example' };
  it('accepts an explicit production configuration', () => expect(validateEnv(production).NODE_ENV).toBe('production'));
  it.each([{ CONFIG_ENCRYPTION_KEY: '' }, { CONFIG_ENCRYPTION_KEY: 'invalid' }, { JWT_SECRET: 'short-secret-123456' }, { AI_SERVICE_TOKEN: 'dev-internal-token' }, { DASHBOARD_ORIGIN: 'http://dashboard.example' }, { DASHBOARD_ORIGIN: 'invalid' }])('rejects unsafe production configuration %j', patch => {
    expect(() => validateEnv({ ...production, ...patch })).toThrow('Invalid environment configuration');
  });
});

it('validates AI response data before trusting it as persisted content', async () => {
  const client = new AiClient(new ConfigService({ AI_SERVICE_URL: 'https://ai.example', AI_SERVICE_TOKEN: 'test' }) as never);
  const suggestion = { kind: 'headline', title: 'Title', detail: 'Detail', riskLevel: 'low', selector: '#hero', proposedValue: 'Text', originalValue: null, expectedImpact: null };
  const input = { siteId: 'site', pageMap: {}, metrics: {} };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ model: 'test', score: 80, suggestions: [suggestion] }));
  expect(await client.analyze(input)).toMatchObject({ score: 80, suggestions: [{ selector: '#hero' }] });
  fetch.mockResolvedValueOnce(Response.json({ model: 'test', score: 80, suggestions: [{ ...suggestion, selector: 'script[src="evil"]' }] }));
  expect(await client.analyze(input)).toBeNull();
  fetch.mockResolvedValueOnce(Response.json({ model: 'test', score: 80, suggestions: Array(51).fill(suggestion) }));
  expect(await client.analyze(input)).toBeNull();
});
