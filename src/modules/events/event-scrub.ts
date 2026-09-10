import { z } from 'zod';

/**
 * Server-side validation + PII scrubbing for the ingestion edge. This repeats
 * the SDK's client-side safeguards (defense in depth): the API must never be
 * the source of a PII leak. Mirrors docs/EVENT_SCHEMA.md.
 */

export const EVENT_NAMES = [
  'page_view',
  'scroll_depth',
  'cta_click',
  'dead_click',
  'rage_click',
  'form_start',
  'form_submit',
  'section_view',
  'hover',
  'dwell',
  'dropoff',
  'exposure',
  'conversion',
  'page_map',
  'company_context',
] as const;

const WireEventSchema = z.object({
  n: z.enum(EVENT_NAMES),
  t: z.number().nonnegative().max(24 * 3600 * 1000),
  sec: z.string().max(64).optional(),
  sel: z.string().max(256).optional(),
  sd: z.number().int().min(0).max(100).optional(),
  dw: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
  exp: z.string().uuid().optional(),
  var: z.string().uuid().optional(),
  goal: z.string().max(64).optional(),
  val: z.number().finite().optional(),
  p: z.record(z.unknown()).optional(),
});
export type WireEvent = z.infer<typeof WireEventSchema>;

export const EnvelopeSchema = z.object({
  v: z.literal(1),
  siteId: z.string().uuid(),
  ik: z.string().min(1).max(128),
  sid: z.string().min(1).max(128),
  sentAt: z.number().optional(),
  ctx: z.object({
    path: z.string().max(512),
    ref: z.string().max(255).default(''),
    dev: z.enum(['mobile', 'tablet', 'desktop']).default('desktop'),
    br: z.enum(['chromium', 'firefox', 'safari', 'edge', 'other']).default('other'),
    vp: z.tuple([z.number(), z.number()]).optional(),
    lang: z.string().max(8).default('en'),
  }),
  events: z.array(WireEventSchema).min(1).max(50),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;
const CC = /\b(?:\d[ -]*?){13,16}\b/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;

export function looksLikePii(value: string): boolean {
  return EMAIL.test(value) || PHONE.test(value) || CC.test(value) || SSN.test(value);
}

/** Strip PII-shaped values from a props object; cap size. Returns JSON string. */
export function scrubProps(props: Record<string, unknown> | undefined): string {
  if (!props) return '';
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(props)) {
    if (keys >= 20) break;
    const val = scrubValue(v);
    if (val === undefined) continue;
    out[k.slice(0, 64)] = val;
    keys++;
  }
  try {
    const s = JSON.stringify(out);
    return s.length > 4096 ? '' : s;
  } catch {
    return '';
  }
}

function scrubValue(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return looksLikePii(v) ? undefined : v.slice(0, 256);
  if (Array.isArray(v)) {
    const arr = v.slice(0, 10).map(scrubValue).filter((x) => x !== undefined);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

/** Strip query/hash from a path defensively (should already be stripped). */
export function sanitizePath(path: string): string {
  const q = path.indexOf('?');
  const h = path.indexOf('#');
  let end = path.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return path.slice(0, end).slice(0, 512) || '/';
}

/**
 * Server-side mirror of the SDK selector allowlist: only tag/#id/.class chains
 * with descendant/>/+/~ combinators. Blocks attribute selectors (the value
 * exfiltration vector), pseudo-classes, and anything PII-shaped. Returns ''
 * for anything unsafe so an unsafe selector is dropped, never stored.
 */
const SAFE_SELECTOR =
  /^([a-zA-Z][\w-]*|\*|#[a-zA-Z][\w-]*|\.[a-zA-Z_][\w-]*)((\.[a-zA-Z_][\w-]*)|(:nth-of-type\(\d{1,3}\)))*(\s*[>+~]?\s*([a-zA-Z][\w-]*|\*|#[a-zA-Z][\w-]*|\.[a-zA-Z_][\w-]*)((\.[a-zA-Z_][\w-]*)|(:nth-of-type\(\d{1,3}\)))*)*$/;

export function sanitizeSelector(sel: string | undefined): string {
  if (!sel) return '';
  const trimmed = sel.trim().slice(0, 256);
  if (!trimmed || looksLikePii(trimmed)) return '';
  return SAFE_SELECTOR.test(trimmed) ? trimmed : '';
}

/**
 * Structural page-map payload carried in the `p` of a `page_map` event. This
 * bypasses `scrubProps` (which intentionally drops nested objects) and is
 * validated with its own strict schema, then persisted to Postgres — it is
 * structural site metadata, not behavioral analytics.
 */
const PageMapNodeSchema = z.object({
  role: z.string().min(1).max(24),
  selector: z.string().min(1).max(256),
  tag: z.string().min(1).max(24),
  text: z.string().max(120).optional(),
  textHash: z.number().int().optional(),
});

export const PageMapPayloadSchema = z.object({
  path: z.string().max(512),
  counts: z.record(z.number().int().nonnegative()).optional(),
  nodes: z.array(PageMapNodeSchema).max(60),
});
export type PageMapPayload = z.infer<typeof PageMapPayloadSchema>;

/**
 * Validate + sanitize a page_map payload. Nodes with unsafe selectors or
 * PII-shaped text are dropped rather than rejected wholesale.
 */
export function parsePageMapPayload(p: unknown): PageMapPayload | null {
  const parsed = PageMapPayloadSchema.safeParse(p);
  if (!parsed.success) return null;
  const nodes = parsed.data.nodes.flatMap((node) => {
    const selector = sanitizeSelector(node.selector);
    if (!selector) return [];
    const clean: PageMapPayload['nodes'][number] = {
      role: node.role,
      selector,
      tag: node.tag,
    };
    if (node.text !== undefined && !looksLikePii(node.text)) clean.text = node.text;
    if (node.textHash !== undefined) clean.textHash = node.textHash;
    return [clean];
  });
  if (nodes.length === 0) return null;
  return {
    path: sanitizePath(parsed.data.path),
    counts: parsed.data.counts ?? {},
    nodes,
  };
}
