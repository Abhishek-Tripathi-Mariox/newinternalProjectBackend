import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
import { AppError } from './errors.js';

/**
 * Encryption for stored secrets (project third-party credentials): AES-256-GCM with a random IV
 * per value. Stored as "v1:<iv>:<tag>:<ciphertext>" (base64 parts). Key: CREDENTIALS_KEY.
 */
export const secretsEnabled = () => !!config.credentialsKey;

function key() {
  if (!config.credentialsKey) {
    throw new AppError(503, 'CREDENTIALS_DISABLED', 'Saving credentials is turned off: set CREDENTIALS_KEY in the server .env (openssl rand -base64 32).');
  }
  return config.credentialsKey;
}

export function seal(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function open(sealed) {
  const [v, iv, tag, ct] = String(sealed).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
