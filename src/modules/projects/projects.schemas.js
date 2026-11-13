import { z } from 'zod';
import { includeParam } from '../../core/include.js';
import { PROJECT_STATUSES, MILESTONE_STATUSES, TEAMS } from './projects.domain.js';

export const PROJECT_ID = /^PR-\d{1,9}$/;
export const MILESTONE_ID = /^PR-\d{1,9}-(M\d{1,4}|CR-\d{1,9}-\d{1,6})$/;
export const MEMBER_ID = /^[A-Za-z0-9_-]{1,40}$/;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');
const optDay = z.union([day, z.literal('')]).optional();
const priority = z.enum(['High', 'Medium', 'Low']);
const hours = z.coerce.number().min(0).max(100000);
const memberId = z.string().regex(MEMBER_ID);
const clientEmail = z.union([z.string().trim().toLowerCase().email('Enter a valid client email').max(200), z.literal('')]);
const link = z.object({ type: z.string().trim().min(1).max(40).default('Other'), url: z.string().max(2000).default('') });

export const projectParams = z.object({ id: z.string().regex(PROJECT_ID, 'Invalid project id') });
export const memberParams = projectParams.extend({ memberId: z.string().regex(MEMBER_ID, 'Invalid member id') });
export const milestoneParams = z.object({ id: z.string().regex(MILESTONE_ID, 'Invalid milestone id') });

export const PERIODS = ['today', 'yesterday', 'week', '7d', 'month', 'lastmonth', '30d', '90d', 'all', 'custom'];
/** Optional query filter; '' means "not set". */
const blank = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const filters = {
  q: z.string().max(200).optional(),
  status: blank(z.enum(PROJECT_STATUSES)),
  team: blank(z.enum(TEAMS)),
  member: blank(z.string().regex(MEMBER_ID)),
  project: blank(z.string().regex(PROJECT_ID)),
  period: z.enum(PERIODS).default('week'),
  from: optDay,
  to: optDay,
};

export const listQuery = z.object({
  ...filters,
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().max(30).optional(),
  include: includeParam(['documents']),
});
export const overviewQuery = z.object(filters);
export const capacityQuery = z.object({ ...filters, week: z.coerce.number().int().min(0).max(2).default(0) });
export const detailQuery = z.object({ day: day.optional(), period: z.enum(PERIODS).default('week'), from: optDay, to: optDay });

/** One milestone typed in the new-project form / added from the drawer. */
export const milestoneInput = z.object({
  name: z.string().trim().max(200).default(''),
  dueDate: day,
  allocHours: hours.default(0),
  team: z.array(memberId).max(50).optional(),
  notes: z.string().max(10000).optional(),
});

export const createProjectSchema = z.object({
  name: z.string().max(200).default(''),
  client: z.string().max(200).default(''),
  services: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  service: z.string().max(80).optional(), // frontend form sends one service
  status: z.enum(PROJECT_STATUSES).default('Planning'),
  pmId: memberId.optional(),
  startDate: optDay,
  dueDate: optDay,
  budgetHours: hours.default(0),
  team: z.array(memberId).max(100).default([]),
  primaryTeam: z.array(memberId).max(100).default([]), // primary developers (subset of the team)
  value: z.coerce.number().min(0).max(1e12).default(0),
  priority: priority.default('Medium'),
  brief: z.string().max(10000).default(''),
  clientEmail: clientEmail.default(''),
  links: z.array(link).max(50).default([]),
  milestones: z.array(milestoneInput).max(30).optional(), // omitted → the five template milestones
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  client: z.string().trim().min(1).max(200),
  services: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  status: z.enum(PROJECT_STATUSES),
  pmId: memberId,
  startDate: day,
  dueDate: day,
  value: z.coerce.number().min(0).max(1e12),
  priority,
  brief: z.string().max(10000),
  clientEmail,
  budgetHours: z.union([z.null(), hours]), // null = no budget set (no limit)
}).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const allocSchema = z.object({ allocHours: hours.optional(), primary: z.boolean().optional() })
  .refine((b) => b.allocHours !== undefined || b.primary !== undefined, 'Nothing to update');
export const addMemberSchema = z.object({ memberId, allocHours: hours.default(0) });
export const linksSchema = z.object({ links: z.array(link).max(50) });
export const portalSchema = z.object({ on: z.boolean() });

/** GET /milestones — all milestones of visible projects (optionally one project), paginated (pageSize ≤ 100). */
export const milestonesQuery = z.object({
  projectId: blank(z.string().regex(PROJECT_ID, 'Invalid project id')),
  status: blank(z.enum(MILESTONE_STATUSES)),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const updateMilestoneSchema = z.object({
  name: z.string().max(200),
  allocHours: hours,
  status: z.enum(MILESTONE_STATUSES),
  dueDate: day,
  team: z.array(memberId).max(50),
  notes: z.string().max(10000),
}).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update');
