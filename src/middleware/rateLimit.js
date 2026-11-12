import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config/index.js';

const json = (message) => (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } });

/** General API limit per client IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Production: 600 requests/min per IP. Development: generous (each sign-in loads ~30 lists).
  limit: config.isProd ? 600 : 10_000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: json('Too many requests — slow down and try again in a minute'),
});

/** Brute-force protection for login: per IP + email. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isProd ? 10 : 1_000, // strict in production; relaxed for local dev and tests
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // ipKeyGenerator groups IPv6 addresses by /56 subnet so one client can't rotate addresses to dodge the limit.
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase()}`,
  handler: json('Too many login attempts — try again in 15 minutes'),
});
