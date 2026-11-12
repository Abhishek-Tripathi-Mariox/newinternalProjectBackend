import { z } from 'zod';
import { RANGES } from './attendance.domain.js';
import { BREAK_TYPES } from './workday.service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');
const personId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Invalid person id');
const TEAMS = ['Sales', 'Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO'];

export const liveQuery = z.object({
  filter: z.enum(['all', 'attention', 'work', 'break', 'delivery', 'sales', 'absent', 'idle']).optional().default('all'),
  feed: z.enum(['all', 'team', 'sales', 'clients']).optional().default('all'),
});

export const pidParams = z.object({ pid: personId });
export const liveBreakBody = z.object({
  type: z.enum(Object.keys(BREAK_TYPES)).optional(),
  note: z.string().max(500).optional().default(''),
});
export const liveTimerBody = z.object({ taskId: z.string().trim().min(1, 'Pick a task.').max(40) });

const rangeFields = {
  range: z.enum(RANGES).optional().default('today'),
  date: day.optional(),
};

export const attendanceQuery = z.object({
  ...rangeFields,
  team: z.enum(TEAMS).optional(),
  q: z.string().max(100).optional().default(''),
  person: personId.optional(),
});

export const timelineQuery = z.object({
  mode: z.enum(['day', 'week']).optional().default('day'),
  day: day.optional(),
  team: z.enum(TEAMS).optional(),
});

export const hoursLogQuery = z.object({ ...rangeFields, person: personId.optional() });

/** Raw-data endpoints (/attendance/events, /shift-reports): inclusive day bounds + optional person. */
export const eventsQuery = z.object({ from: day.optional(), to: day.optional(), person: personId.optional() });
export const shiftReportsQuery = eventsQuery;
