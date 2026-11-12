import { z } from 'zod';
import { includeParam } from '../../core/include.js';
import { CR_STATUSES } from '../projects/projects.domain.js';
import { PROJECT_ID, MILESTONE_ID, MEMBER_ID } from '../projects/projects.schemas.js';

export const CR_ID = /^CR-\d{1,9}-\d{1,6}$/;

const blank = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const memberId = z.string().regex(MEMBER_ID);
const task = z.object({
  title: z.string().max(300).default(''),
  assigneeId: z.union([memberId, z.literal(''), z.null()]).optional(),
  hours: z.coerce.number().min(0).max(10000).default(0),
});

export const crParams = z.object({ id: z.string().regex(CR_ID, 'Invalid change request id') });

export const listQuery = z.object({
  status: blank(z.enum(CR_STATUSES)),
  project: blank(z.string().regex(PROJECT_ID)),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  include: includeParam(['history', 'documents']),
});

const fields = {
  title: z.string().max(300).default(''),
  description: z.string().max(20000).default(''),
  requestedBy: z.enum(['Client', 'Internal']).default('Client'),
  requestedByName: z.string().max(200).default(''),
  hours: z.coerce.number().min(0).max(100000).default(0),
  rate: z.coerce.number().min(0).max(1e7).optional(),
  extraDays: z.coerce.number().min(0).max(3650).default(0),
  priority: z.enum(['High', 'Medium', 'Low']).default('Medium'),
  target: z.union([z.literal('new'), z.string().regex(MILESTONE_ID)]).default('new'),
  team: z.array(memberId).max(100).default([]),
  tasks: z.array(task).max(200).default([]),
};

export const createCrSchema = z.object({ projectId: z.string().regex(PROJECT_ID), ...fields, send: z.boolean().default(false) });

// PATCH: every field optional, no defaults (unset = keep the current value).
export const updateCrSchema = z.object({
  title: z.string().max(300),
  description: z.string().max(20000),
  requestedBy: z.enum(['Client', 'Internal']),
  requestedByName: z.string().max(200),
  hours: z.coerce.number().min(0).max(100000),
  rate: z.coerce.number().min(0).max(1e7),
  extraDays: z.coerce.number().min(0).max(3650),
  priority: z.enum(['High', 'Medium', 'Low']),
  target: z.union([z.literal('new'), z.string().regex(MILESTONE_ID)]),
  team: z.array(memberId).max(100),
  tasks: z.array(task).max(200),
  send: z.boolean(),
}).partial();

export const actionSchema = z.object({
  act: z.enum(['send', 'approve', 'reject', 'start', 'done']),
  note: z.string().max(5000).optional(),
  signer: z.object({ name: z.string().max(200).default(''), title: z.string().max(200).optional() }).optional(),
});
