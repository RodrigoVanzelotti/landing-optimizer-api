import type { LoggerService } from '@nestjs/common';
import { cleanLogValue, safeReason } from './request-context';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';
export type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  verbose: 5,
};
const RESERVED_FIELDS = new Set(['timestamp', 'level', 'service', 'logger']);
let defaultLevel = normalizeLevel(process.env['LOG_LEVEL'] ?? 'info');

/** Return the cached structured logger for a module or service context. */
export function Logger(context: string, level?: string): ApiLogger {
  return ApiLogger.forContext(context, level);
}

/** Apply the validated level to existing and future singleton instances. */
export function configureLogger(level: string): void {
  defaultLevel = normalizeLevel(level);
  ApiLogger.configure(defaultLevel);
}

/** Structured application logger that also accepts Nest framework log calls. */
export class ApiLogger implements LoggerService {
  private static readonly instances = new Map<string, ApiLogger>();
  private threshold: number;

  static forContext(context: string, level?: string): ApiLogger {
    const safeContext = cleanLogValue(context, 128) || 'Application';
    const existing = this.instances.get(safeContext);
    if (existing) return existing;

    const logger = new ApiLogger(safeContext, level ?? defaultLevel);
    this.instances.set(safeContext, logger);
    return logger;
  }

  static configure(level: LogLevel): void {
    for (const logger of this.instances.values()) logger.threshold = LEVEL_WEIGHT[level];
  }

  private constructor(
    private readonly context: string,
    level: string,
  ) {
    this.threshold = LEVEL_WEIGHT[normalizeLevel(level)];
  }

  info(event: string, fields: LogFields = {}): void {
    this.emitEvent('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emitCompatible('warn', message, optionalParams);
  }

  warning(event: string, fields: LogFields = {}): void {
    this.emitEvent('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emitCompatible('error', message, optionalParams);
  }

  exception(event: string, error: unknown, fields: LogFields = {}): void {
    this.emitEvent(
      'error',
      event,
      { ...fields, reason: fields['reason'] ?? safeReason(error) },
      error,
    );
  }

  debug(event: string, fields?: LogFields): void;
  debug(message: unknown, ...optionalParams: unknown[]): void;
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emitCompatible('debug', message, optionalParams);
  }

  verbose(event: string, fields?: LogFields): void;
  verbose(message: unknown, ...optionalParams: unknown[]): void;
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emitCompatible('verbose', message, optionalParams);
  }

  fatal(event: string, fields?: LogFields): void;
  fatal(message: unknown, ...optionalParams: unknown[]): void;
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emitCompatible('fatal', message, optionalParams);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emitCompatible('info', message, optionalParams);
  }

  private emitCompatible(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    if (typeof message === 'string') {
      if (optionalParams.length === 0) {
        this.emitEvent(level, message, {});
        return;
      }
      if (isFields(optionalParams[0])) {
        this.emitEvent(level, message, optionalParams[0]);
        return;
      }
    }
    this.emitFramework(level, message, optionalParams);
  }

  private emitEvent(
    level: LogLevel,
    event: string,
    fields: LogFields,
    error?: unknown,
  ): void {
    const output = this.base(level, this.context);
    output['event'] = cleanLogValue(event, 128);
    appendFields(output, fields);
    if (error instanceof Error && error.stack) output['stack'] = cleanLogValue(error.stack, 8000);
    this.write(level, output);
  }

  private emitFramework(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    const params = [...optionalParams];
    const context = takeLastString(params) ?? this.context;
    const stack = level === 'error' || level === 'fatal' ? takeLastString(params) : undefined;
    const output = this.base(level, context);

    if (isFields(message)) {
      appendFields(output, message);
      if (!('event' in output) && !('message' in output)) output['message'] = 'structured_log';
    } else if (message instanceof Error) {
      output['message'] = safeReason(message);
      output['error_type'] = message.name;
      if (message.stack) output['stack'] = cleanLogValue(message.stack, 8000);
    } else {
      output['message'] = cleanLogValue(String(message), 2000);
    }

    if (stack) output['stack'] = cleanLogValue(stack, 8000);
    if (params.length > 0) output['details'] = params.slice(0, 20).map(jsonValue);
    this.write(level, output);
  }

  private base(level: LogLevel, context: string): LogFields {
    return {
      timestamp: new Date().toISOString(),
      level,
      service: 'landing-optimizer-api',
      logger: cleanLogValue(context, 128),
    };
  }

  private write(level: LogLevel, output: LogFields): void {
    if (LEVEL_WEIGHT[level] > this.threshold) return;
    const line = `${JSON.stringify(output)}\n`;
    if (level === 'error' || level === 'fatal') process.stderr.write(line);
    else process.stdout.write(line);
  }
}

function normalizeLevel(value: string): LogLevel {
  const level = value.toLowerCase();
  if (level === 'log') return 'info';
  return level in LEVEL_WEIGHT ? (level as LogLevel) : 'info';
}

function appendFields(output: LogFields, fields: LogFields): void {
  for (const [key, value] of Object.entries(fields)) {
    const safeKey = cleanLogValue(key, 128);
    if (!safeKey || RESERVED_FIELDS.has(safeKey)) continue;
    output[safeKey] = jsonValue(value);
  }
}

function takeLastString(values: unknown[]): string | undefined {
  const value = values.at(-1);
  if (typeof value !== 'string') return undefined;
  values.pop();
  return value;
}

function isFields(value: unknown): value is LogFields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Error);
}

function jsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return cleanLogValue(value, 2000);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return safeReason(value);
  if (depth >= 3) return cleanLogValue(String(value), 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => jsonValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: LogFields = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[cleanLogValue(key, 128)] = jsonValue(item, depth + 1);
    }
    return output;
  }
  return cleanLogValue(String(value), 2000);
}