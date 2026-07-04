import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as edSign,
} from 'node:crypto';
import type { AppEnv } from '../../config/env';
import { canonicalJson } from './canonical-json';

export interface SiteKeyPair {
  /** base64 raw Ed25519 public key (32 bytes) — embedded in the snippet. */
  publicKey: string;
  /** AES-256-GCM encrypted PKCS8 private key for storage at rest. */
  privateKeyEnc: Buffer;
}

/**
 * Per-site Ed25519 signing keys + config signing. The signing canonicalization
 * MUST match the snippet's `canonicalJson` (recursively sorted keys) so the
 * browser can verify the signature. Private keys are encrypted at rest with
 * AES-256-GCM using a KMS-provided key in production.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly encKey: Buffer;

  constructor(config: ConfigService<AppEnv, true>) {
    const raw = config.get('CONFIG_ENCRYPTION_KEY', { infer: true });
    if (raw) {
      this.encKey = Buffer.from(raw, 'base64');
      if (this.encKey.length !== 32) {
        throw new Error('CONFIG_ENCRYPTION_KEY must be 32 bytes (base64)');
      }
    } else {
      // Development fallback only — never hit in production (env is validated
      // and this key should be provided by KMS/secrets manager).
      this.logger.warn('CONFIG_ENCRYPTION_KEY not set — using insecure dev key');
      this.encKey = scryptSync('dev-insecure-key', 'lo-dev-salt', 32);
    }
  }

  /** Generate a fresh Ed25519 keypair for a new site. */
  generateSiteKeyPair(): SiteKeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
    if (!jwk.x) throw new Error('failed to export public key');
    const rawPublic = Buffer.from(jwk.x, 'base64url');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    return {
      publicKey: rawPublic.toString('base64'),
      privateKeyEnc: this.encrypt(pkcs8),
    };
  }

  /** Sign the canonical JSON of `payload` with the site's private key. */
  signConfig(privateKeyEnc: Buffer, payload: unknown): string {
    const pkcs8 = this.decrypt(privateKeyEnc);
    const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    const data = Buffer.from(canonicalJson(payload), 'utf8');
    const signature = edSign(null, data, key);
    return signature.toString('base64');
  }

  /* -------------------------- AES-256-GCM at rest ------------------------- */

  private encrypt(plaintext: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // layout: [12 iv][16 tag][ciphertext]
    return Buffer.concat([iv, tag, enc]);
  }

  private decrypt(blob: Buffer): Buffer {
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const enc = blob.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }
}
