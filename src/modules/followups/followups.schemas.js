import { z } from 'zod';

export const FU_ID = /^F\d{1,9}$/;
export const FU_TYPES = ['Meeting', 'Call', 'Task', 'Reminder'];
export const PRIORITIES = ['High', 'Medium', 'Low'];
/** Defaults per type: [duration min, reminder min] (frontend FU_DEFAULTS). */
export const FU_DEFAULTS = { Meeting: [45, 10], Call: [15, 10], Task: [0, 60], Reminder: [0, 0] };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const optDay = z.union([z.string().regex(DAY_RE, 'Use YYYY-MM-DD'), z.literal('')]).optional().transform((v) => v || undefined);
const optStr = (max = 200) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const leadId = z.union([z.string().regex(/^MX-\d{1,9}$/, 'Invalid lead id'), z.literal(''), z.null()]).optional()
  .transform((v) => (v === '' ? null : v));

export const idParams = z.object({ id: z.string().regex(FU_ID, 'Invalid follow-up id') });

export const listQuery = z.object({
  tab: z.enum(['today', 'upcoming', 'overdue', 'completed', 'all']).default('all'),
  type: z.enum([...FU_TYPES, '']).optional().transform((v) => v || undefined),
  owner: optStr(50),
  priority: z.enum([...PRIORITIES, '']).optional().transform((v) => v || undefined),
  meet: z.enum(['yes', 'no', '']).optional().transform((v) => v || undefined),
  leadId: optStr(20),
  q: optStr(),
  from: optDay,
  to: optDay,
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().max(30).optional(),
});

const base = {
  title: z.string().max(300),
  leadId,
  ownerId: z.string().max(50).optional(),
  dueAt: z.string().max(40).optional(),
  date: z.string().max(10).optional(),
  time: z.string().max(8).optional(),
  durationMin: z.coerce.number().int().min(0).max(1440).optional(),
  remindMin: z.coerce.number().int().min(0).max(10080).optional(),
  priority: z.enum(PRIORITIES).optional(),
  meetUrl: z.string().trim().max(500).refine((v) => !v || /^https?:\/\//i.test(v), 'Use an http(s) link').optional(),
  attendees: z.string().max(2000).optional(),
  notes: z.string().max(10000).optional(),
};

export const createSchema = z.object({ ...base, type: z.enum(FU_TYPES).default('Meeting'), title: base.title.default('') });
export const updateSchema = z.object({ ...base, type: z.enum(FU_TYPES).optional(), title: base.title.optional() });

export const ackSchema = z.object({ ids: z.array(z.string().regex(FU_ID)).min(1).max(200) });
