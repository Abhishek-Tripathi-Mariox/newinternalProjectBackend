import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/** Short-lived JWT access token (sent as Authorization: Bearer). */
export const signAccessToken = (user) => jwt.sign({ sub: user.id, role: user.role_id || (user.role && user.role.id) }, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl });

/** Opaque refresh token (random) + its sha256 for storage; rotated on every refresh. */
export function newRefreshToken() {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token), expiresAt: new Date(Date.now() + config.jwt.refreshTtlDays * 864e5) };
}
export const hashToken = (t) => createHash('sha256').update(t).digest('hex');

export const REFRESH_COOKIE = 'mx_refresh';
export const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: config.isProd,
  sameSite: 'lax',
  path: '/api/v1/auth',
  maxAge: config.jwt.refreshTtlDays * 864e5,
});
