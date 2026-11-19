import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import { AppError, unauthorized } from '../../core/errors.js';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/**
 * Server-to-server guard for the founder summary: `x-founder-key` must equal FOUNDER_API_KEY.
 * Compared as SHA-256 digests with timingSafeEqual, so neither the length nor the content leaks.
 * When the key isn't configured the endpoint is switched off (503).
 */
export function founderKey(req, _res, next) {
  const expected = config.founderApiKey;
  if (!expected) throw new AppError(503, 'NOT_CONFIGURED', 'The founder summary is turned off. Set FOUNDER_API_KEY to turn it on.');
  const got = req.get('x-founder-key') || '';
  if (!got || !crypto.timingSafeEqual(digest(got), digest(expected))) throw unauthorized('Invalid founder key');
  next();
}
