import { describe, expect, it } from 'vitest';
import {
  matchesContentType,
  MAX_IMAGE_BYTES,
  imageDimensions,
  SnapshotEnvelopeSchema,
} from '../src/modules/snapshots/snapshots.dto';

const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    siteId: '018f6b2a-0000-7000-8000-000000000000',
    ik: 'ik_test',
    path: '/pricing',
    width: 1280,
    height: 4200,
    contentType: 'image/png',
    image: pngBytes.toString('base64'),
    nodes: [{ selector: '#hero', role: 'hero', rect: [0, 0, 1280, 600] }],
    ...overrides,
  };
}

describe('SnapshotEnvelopeSchema', () => {
  it('accepts a valid capture envelope', () => {
    const parsed = SnapshotEnvelopeSchema.safeParse(validEnvelope());
    expect(parsed.success).toBe(true);
  });

  it('defaults nodes to an empty array', () => {
    const { nodes: _nodes, ...rest } = validEnvelope();
    const parsed = SnapshotEnvelopeSchema.parse(rest);
    expect(parsed.nodes).toEqual([]);
  });

  it('rejects non-base64 image data', () => {
    expect(
      SnapshotEnvelopeSchema.safeParse(validEnvelope({ image: 'not base64!!' })).success,
    ).toBe(false);
  });

  it('rejects out-of-range dimensions', () => {
    expect(SnapshotEnvelopeSchema.safeParse(validEnvelope({ width: 10 })).success).toBe(false);
    expect(SnapshotEnvelopeSchema.safeParse(validEnvelope({ height: 100000 })).success).toBe(
      false,
    );
  });

  it('rejects unknown content types and zero-size rects', () => {
    expect(
      SnapshotEnvelopeSchema.safeParse(validEnvelope({ contentType: 'image/svg+xml' })).success,
    ).toBe(false);
    expect(
      SnapshotEnvelopeSchema.safeParse(
        validEnvelope({ nodes: [{ selector: '#x', role: 'cta', rect: [0, 0, 0, 10] }] }),
      ).success,
    ).toBe(false);
  });
});

describe('matchesContentType', () => {
  it('reads PNG, JPEG and WebP dimensions and safely rejects truncated headers', () => {
    const png = Buffer.alloc(32);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write('IHDR', 12); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
    expect(imageDimensions(png, 'image/png')).toEqual([800, 600]);
    const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 2, 88, 3, 32, 1]);
    expect(imageDimensions(jpeg, 'image/jpeg')).toEqual([800, 600]);
    const webp = Buffer.alloc(30);
    webp.write('RIFF'); webp.write('WEBP', 8); webp.write('VP8X', 12);
    webp.writeUIntLE(799, 24, 3); webp.writeUIntLE(599, 27, 3);
    expect(imageDimensions(webp, 'image/webp')).toEqual([800, 600]);
    webp.write('VP8 ', 12); Buffer.from([157, 1, 42]).copy(webp, 23);
    webp.writeUInt16LE(800, 26); webp.writeUInt16LE(600, 28);
    expect(imageDimensions(webp, 'image/webp')).toEqual([800, 600]);
    webp.fill(0, 16); webp.write('VP8L', 12); webp[20] = 0x2f;
    webp.writeUInt32LE(799 | (599 << 14), 21);
    expect(imageDimensions(webp, 'image/webp')).toEqual([800, 600]);
    for (let length = 0; length < 12; length++) expect(imageDimensions(jpeg.subarray(0, length), 'image/jpeg')).toBeNull();
    expect(imageDimensions(png.subarray(0, 23), 'image/png')).toBeNull();
    expect(imageDimensions(webp.subarray(0, 24), 'image/webp')).toBeNull();
  });
  it('validates magic bytes per declared type', () => {
    expect(matchesContentType(pngBytes, 'image/png')).toBe(true);
    expect(matchesContentType(pngBytes, 'image/jpeg')).toBe(false);

    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    expect(matchesContentType(jpeg, 'image/jpeg')).toBe(true);

    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'latin1'),
      Buffer.alloc(16),
    ]);
    expect(matchesContentType(webp, 'image/webp')).toBe(true);
    expect(matchesContentType(webp, 'image/png')).toBe(false);
  });

  it('rejects tiny buffers', () => {
    expect(matchesContentType(Buffer.alloc(4), 'image/png')).toBe(false);
  });

  it('exports a sane size cap', () => {
    expect(MAX_IMAGE_BYTES).toBe(3 * 1024 * 1024);
  });
});
