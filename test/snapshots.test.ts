import { describe, expect, it } from 'vitest';
import {
  matchesContentType,
  MAX_IMAGE_BYTES,
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
