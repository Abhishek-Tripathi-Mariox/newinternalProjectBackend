import { z } from 'zod';
import { includeParam } from '../../core/include.js';
import { day, memberId, milestoneId, PRIORITIES, projectId, TEAMS } from '../tasks/tasks.schemas.js';
import { PERIOD_PRESETS } from '../timesheets/period.js';

export const BUG_STATUSES = ['Open', 'In progress', 'Fixed', 'Retest', 'Reopened', 'Closed'];
export const SEVERITIES = ['Critical', 'Major', 'Minor', 'Trivial'];
export const BUG_ENVS = ['Android', 'iOS', 'Web', 'API / Backend', 'Admin panel'];
export const SEVERITY_DAYS = { Critical: 1, Major: 3, Minor: 7, Trivial: 14 };

const blankToNull = (v) => (v === '' ? null : v);
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const reporter = z.string().regex(/^[\w-]{1,40}$/, 'Invalid reporter'); // member id or 'client'

export const bugIdParams = z.object({ id: z.string().regex(/^BUG-\d+$/, 'Invalid bug id') });

export const listBugsQuery = z.object({
  project: projectId.optional(),
  projectStatus: z.enum(['Running', 'On hold', 'Completed', 'Planning', 'Cancelled']).optional(),
  member: memberId.optional(),
  team: z.enum(TEAMS).optional(),
  dept: z.enum(TEAMS).optional(),
  sev: z.enum(SEVERITIES).optional(),
  env: z.enum(BUG_ENVS).optional(),
  reporter: reporter.optional(),
  status: z.enum(BUG_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  quick: z.enum(['open', 'overdue', 'critical', 'reopened', 'unassigned', 'closed', 'all', '']).default('open'),
  allTime: bool.default(true),
  date: z.enum(PERIOD_PRESETS).optional(),
  from: day.optional(),
  to: day.optional(),
  sort: z.string().max(30).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  include: includeParam(['events', 'attachments']),
});

const fields = {
  title: z.string().max(300),
  projectId,
  milestoneId: z.preprocess(blankToNull, milestoneId.nullable()),
  dept: z.enum(TEAMS),
  env: z.enum(BUG_ENVS),
  severity: z.enum(SEVERITIES),
  priority: z.enum(PRIORITIES),
  status: z.enum(BUG_STATUSES),
  assigneeId: z.preprocess(blankToNull, memberId.nullable()),
  reporter,
  reportedOn: day,
  dueDate: z.preprocess(blankToNull, day.nullable()),
  build: z.string().max(200),
  steps: z.string().max(20000),
  expected: z.string().max(10000),
  actual: z.string().max(10000),
  link: z.string().max(2000),
};

export const createBugSchema = z.object({
  ...fields,
  title: fields.title.default(''),
  milestoneId: fields.milestoneId.optional(),
  dept: fields.dept.default('Web'),
  env: fields.env.default('Web'),
  severity: fields.severity.default('Major'),
  priority: fields.priority.optional(),
  status: fields.status.default('Open'),
  assigneeId: fields.assigneeId.optional(),
  reporter: reporter.optional(),
  reportedOn: day.optional(),
  dueDate: fields.dueDate.optional(),
  build: fields.build.default(''),
  steps: fields.steps.default(''),
  expected: fields.expected.default(''),
  actual: fields.actual.default(''),
  link: fields.link.default(''),
});

export const updateBugSchema = z.object({
  ...fields,
  removeAttachmentIds: z.array(z.uuid()).max(50),
}).partial();

export const commentSchema = z.object({ text: z.string().max(5000).default('') });
