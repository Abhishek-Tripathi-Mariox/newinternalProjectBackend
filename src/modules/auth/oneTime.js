import { randomBytes } from 'node:crypto';
import { hashToken } from '../../core/tokens.js';

export const INVITE_TTL_DAYS = 7;
export const RESET_TTL_HOURS = 24;

/** One-time token (invite / password reset): raw value for the response, sha256 for the DB. */
export function oneTimeToken(ttlMs) {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) };
}

export const newInvite = () => oneTimeToken(INVITE_TTL_DAYS * 864e5);
export const newReset = () => oneTimeToken(RESET_TTL_HOURS * 36e5);
