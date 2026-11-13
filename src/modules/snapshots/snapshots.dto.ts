import { z } from 'zod';

/**
 * Wire contract for `POST /v1/snapshots` — the operator-triggered page
 * snapshot uploaded by the lo-capture SDK bundle (docs/EVENT_SCHEMA §8).
 * Uploaded from the dashboard with an editor JWT and site ownership checks.
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

/** Inspect raster dimensions before a viewer's browser allocates decoded pixels. */
export function imageDimensions(buf: Buffer, contentType: SnapshotContentType): [number, number] | null {
  if (!matchesContentType(buf, contentType)) return null;
  if (contentType === 'image/png') {
    if (buf.length < 24 || !buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  }
  if (contentType === 'image/webp') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buf.length >= 30) return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
    if (chunk === 'VP8 ' && buf.length >= 30 && buf.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    return null;
  }
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    if (buf[offset + 1] === 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buf.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker!)) {
      if (length < 8) return null;
      return [buf.readUInt16BE(offset + 7), buf.readUInt16BE(offset + 5)];
    }
    offset += 2 + length;
  }
  return null;
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
