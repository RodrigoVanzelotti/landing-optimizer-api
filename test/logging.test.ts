import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanLogValue,
  requestIdOf,
  requestPath,
  safeReason,
  type RequestContext,
} from '../src/common/logging/request-context';
import { configureLogger, Logger } from '../src/common/logging/logger';

afterEach(() => {
  configureLogger('info');
  vi.restoreAllMocks();
});

function request(
  url = '/v1/sites?include=secret',
  requestId?: string,
): RequestContext {
  return {
    url,
    headers: requestId ? { 'x-request-id': requestId } : {},
  } as unknown as RequestContext;
}

describe('request correlation', () => {
  it('preserves a safe upstream request ID', () => {
    expect(requestIdOf(request('/v1/sites', 'trace_123.abc-def'))).toBe('trace_123.abc-def');
  });

  it('replaces an unsafe request ID and reuses the generated value', () => {
    const req = request('/v1/sites', 'bad\nforged-log');
    const generated = requestIdOf(req);
    expect(generated).not.toContain('\n');
    expect(requestIdOf(req)).toBe(generated);
  });

  it('logs paths without query strings', () => {
    expect(requestPath(request())).toBe('/v1/sites');
  });
});

describe('safe log values', () => {
  it('collapses control characters and caps values', () => {
    const clean = cleanLogValue(`bad\nvalue\t\u0000\u001b${'x'.repeat(500)}`, 40);
    expect(clean).not.toContain('\n');
    expect(clean).not.toContain('\t');
    expect(clean).not.toContain('\u0000');
    expect(clean).not.toContain('\u001b');
    expect(clean.length).toBe(40);
  });

  it('includes the error class without multiline content', () => {
    expect(safeReason(new Error('network\nfailed'))).toBe('Error:network failed');
  });
});

describe('Logger', () => {
  it('returns the same singleton for a context', () => {
    expect(Logger('SingletonContext')).toBe(Logger('SingletonContext'));
    expect(Logger('SingletonContext')).not.toBe(Logger('OtherContext'));
  });

  it('writes structured events as one JSON line', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Logger('StructuredLogger', 'info').info('transaction_succeeded', {
      request_id: 'request-1',
      status: 201,
    });

    expect(write).toHaveBeenCalledOnce();
    const parsed = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'info',
      service: 'landing-optimizer-api',
      logger: 'StructuredLogger',
      event: 'transaction_succeeded',
      request_id: 'request-1',
      status: 201,
    });
  });

  it('wraps framework text logs in a JSON message field', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Logger('FrameworkAdapter', 'info').log('Application started', 'NestFactory');

    const parsed = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed).toMatchObject({ logger: 'NestFactory', message: 'Application started' });
  });

  it('supports warn without additional fields', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Logger('WarningLogger', 'info').warn('dependency_degraded');

    const parsed = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'warn',
      logger: 'WarningLogger',
      event: 'dependency_degraded',
    });
  });

  it('applies a validated level to existing singleton instances', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = Logger('ReconfiguredLogger', 'info');

    configureLogger('error');
    logger.info('hidden_event');
    expect(write).not.toHaveBeenCalled();

    configureLogger('info');
    logger.info('visible_event');
    expect(write).toHaveBeenCalledOnce();
  });
});
