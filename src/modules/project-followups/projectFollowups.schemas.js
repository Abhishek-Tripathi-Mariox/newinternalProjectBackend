import { z } from 'zod';
import { FU_TYPES, PRIORITIES } from '../followups/followups.schemas.js';
import { PROJECT_ID } from '../projects/projects.schemas.js';

export const PFU_ID = /^PF\d{1,9}$/;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const optDay = z.union([z.string().regex(DAY_RE, 'Use YYYY-MM-DD'), z.literal('')]).optional().transform((v) => v || undefined);
const optStr = (max = 200) => z.string().trim().max(max).optional().transform((v) => v || undefined);

export const idParams = z.object({ id: z.string().regex(PFU_ID, 'Invalid follow-up id') });

export const listQuery = z.object({
  tab: z.enum(['today', 'upcoming', 'overdue', 'completed', 'all']).default('all'),
  projectId: optStr(20),
  owner: optStr(50),
  type: z.enum([...FU_TYPES, '']).optional().transform((v) => v || undefined),
  priority: z.enum([...PRIORITIES, '']).optional().transform((v) => v || undefined),
  q: optStr(),
  from: optDay,
  to: optDay,
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
});

const base = {
  title: z.string().max(300),
  ownerId: z.string().max(50).optional(),
  dueAt: z.string().max(40),
  durationMin: z.coerce.number().int().min(0).max(1440).optional(),
  remindMin: z.coerce.number().int().min(0).max(10080).optional(),
  priority: z.enum(PRIORITIES).optional(),
  meetUrl: z.string().trim().max(500).refine((v) => !v || /^https?:\/\//i.test(v), 'Use an http(s) link').optional(),
  attendees: z.string().max(2000).optional(),
  notes: z.string().max(10000).optional(),
};

export const createSchema = z.object({
  ...base,
  projectId: z.string().regex(PROJECT_ID, 'Pick a project'),
  type: z.enum(FU_TYPES).default('Meeting'),
  title: base.title.default(''),
});
export const updateSchema = z.object({
  ...base,
  projectId: z.string().regex(PROJECT_ID, 'Pick a project').optional(),
  type: z.enum(FU_TYPES).optional(),
  title: base.title.optional(),
  dueAt: base.dueAt.optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to update');
