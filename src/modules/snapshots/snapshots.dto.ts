import { z } from 'zod';

/**
 * Wire contract for `POST /v1/snapshots` — the operator-triggered page
 * snapshot uploaded by the lo-capture SDK bundle (docs/EVENT_SCHEMA §8).
 * Same trust model as event ingestion: public ingest key + origin allowlist +
 * rate limit; no JWT.
 */

/** Max decoded image size (bytes). Base64 inflates ~4/3, checked separately. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4;

export const SNAPSHOT_CONTENT_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const;
export type SnapshotContentType = (typeof SNAPSHOT_CONTENT_TYPES)[number];

const SnapshotNodeSchema = z.object({
  selector: z.string().min(1).max(256),
  role: z.string().min(1).max(24),
  /** document-space [x, y, width, height] in CSS pixels. */
  rect: z.tuple([
    z.number().int().min(0).max(1_000_000),
    z.number().int().min(0).max(1_000_000),
    z.number().int().min(1).max(1_000_000),
    z.number().int().min(1).max(1_000_000),
  ]),
});
export type SnapshotNode = z.infer<typeof SnapshotNodeSchema>;

export const SnapshotEnvelopeSchema = z.object({
  v: z.literal(1),
  siteId: z.string().uuid(),
  ik: z.string().min(1).max(128),
  path: z.string().max(512),
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(200).max(40000),
  contentType: z.enum(SNAPSHOT_CONTENT_TYPES),
  image: z
    .string()
    .min(64)
    .max(MAX_IMAGE_BASE64_CHARS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'image must be base64'),
  nodes: z.array(SnapshotNodeSchema).max(150).default([]),
});
export type SnapshotEnvelope = z.infer<typeof SnapshotEnvelopeSchema>;

/** Magic-byte check so a mislabeled payload is rejected, not stored. */
export function matchesContentType(buf: Buffer, contentType: SnapshotContentType): boolean {
  if (buf.length < 12) return false;
  switch (contentType) {
    case 'image/png':
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/webp':
      return (
        buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP'
      );
    default:
      return false;
  }
}

/** Snapshot metadata returned to the dashboard (image served separately). */
export interface SnapshotMeta {
  id: string;
  urlPath: string;
  width: number;
  height: number;
  contentType: string;
  nodeCount: number;
  capturedAt: string;
}
