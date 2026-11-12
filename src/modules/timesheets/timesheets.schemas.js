import { z } from 'zod';
import { day, memberId, milestoneId, projectId, TEAMS } from '../tasks/tasks.schemas.js';
import { PERIOD_PRESETS } from './period.js';

const PROJECT_STATUSES = ['Running', 'On hold', 'Completed', 'Planning', 'Cancelled'];

export const logIdParams = z.object({ id: z.string().regex(/^L[\w-]+$/, 'Invalid time log id') });

const filters = {
  member: memberId.optional(),
  project: projectId.optional(),
  team: z.enum(TEAMS).optional(),
  milestone: milestoneId.optional(),
  date: z.enum(PERIOD_PRESETS).optional(),
  from: day.optional(),
  to: day.optional(),
};

export const filtersQuery = z.object(filters);

export const listLogsQuery = z.object({
  ...filters,
  sort: z.string().max(30).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

export const teamHoursQuery = z.object({
  member: memberId.optional(),
  team: z.enum(TEAMS).optional(),
  project: projectId.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  date: z.enum(PERIOD_PRESETS).optional(),
  from: day.optional(),
  to: day.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const row = z.object({
  projectId: z.preprocess((v) => (v === '' ? undefined : v), projectId.optional()),
  milestoneId: z.preprocess((v) => (v === '' ? null : v), milestoneId.nullable().optional()),
  hours: z.preprocess((v) => (v === '' || v == null ? 0 : v), z.coerce.number().min(0).max(24)),
  note: z.string().max(2000).default(''),
});

/** saveLog form: { memberId, date, rows:[{projectId, milestoneId?, hours, note}] }. Date is checked in the service ("Pick a date."). */
export const createLogSchema = z.object({
  memberId: memberId.optional(),
  date: z.preprocess((v) => (v === '' ? undefined : v), day.optional()),
  rows: z.array(row).max(50).default([]),
});
