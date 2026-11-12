import { z } from 'zod';
import { BREAK_TYPES } from './workday.service.js';

const text = (max = 5000) => z.string().max(max).optional().default('');

export const breakSchema = z.object({
  type: z.enum(Object.keys(BREAK_TYPES), { message: `Break type must be one of: ${Object.keys(BREAK_TYPES).join(', ')}` }),
  note: text(500),
});

export const timerStartSchema = z.object({ taskId: z.string().trim().min(1, 'Pick a task.').max(40) });

const hours = z.union([z.number(), z.string()]).optional().transform((v) => (v === '' || v == null ? 0 : Number(v)))
  .refine((v) => Number.isFinite(v) && v >= 0 && v <= 24, 'Hours must be between 0 and 24');
const count = z.union([z.number(), z.string()]).optional().transform((v) => (v === '' || v == null ? 0 : Number(v)))
  .refine((v) => Number.isInteger(v) && v >= 0, 'Must be a whole number ≥ 0');

export const endShiftSchema = z.object({
  done: text(), blockers: text(), plan: text(), outcome: text(),
  calls: count, meetings: count,
  rows: z.array(z.object({
    p: z.string().max(40).optional().default(''),
    ms: z.string().max(80).nullable().optional(),
    h: hours,
    note: text(1000),
  })).max(50).optional().default([]),
  internalRows: z.array(z.object({
    cat: z.string().trim().max(60).optional().default('Other'),
    h: hours,
    note: text(1000),
  })).max(20).optional().default([]),
  pmRows: z.array(z.object({
    p: z.string().min(1).max(40),
    st: z.enum(['On track', 'At risk', 'Blocked']).default('On track'),
    note: text(1000),
  })).max(50).optional().default([]),
});
