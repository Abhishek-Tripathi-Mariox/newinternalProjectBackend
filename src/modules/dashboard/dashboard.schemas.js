import { z } from 'zod';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const optDay = z.union([z.string().regex(DAY_RE, 'Use YYYY-MM-DD'), z.literal('')]).optional().transform((v) => v || undefined);

export const salesQuery = z.object({
  period: z.enum(['7', '30', '90', 'ytd', 'custom']).default('30'),
  from: optDay,
  to: optDay,
  owner: z.string().trim().max(50).optional().transform((v) => v || undefined),
});
