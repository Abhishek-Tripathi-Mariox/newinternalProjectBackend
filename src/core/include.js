import { z } from 'zod';

/**
 * `?include=a,b` query param for list endpoints that can embed child arrays.
 * Unknown names are rejected (422) so typos surface; parsed value is a string[] (possibly empty).
 */
export const includeParam = (allowed) => z.union([z.string().max(200), z.array(z.string().max(50)).max(20)])
  .optional()
  .transform((v) => (Array.isArray(v) ? v.join(',') : v || '').split(',').map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.enum(allowed)))
  .transform((a) => Array.from(new Set(a)));
