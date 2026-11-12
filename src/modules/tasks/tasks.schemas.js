import { z } from 'zod';

export const TASK_STATUSES = ['To do', 'In progress', 'Blocked', 'In review', 'Done'];
export const PRIORITIES = ['High', 'Medium', 'Low'];
export const TEAMS = ['Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO'];

export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const projectId = z.string().regex(/^PR-\d+$/, 'Invalid project id');
export const milestoneId = z.string().regex(/^PR-\d+-[\w-]+$/, 'Invalid milestone id');
export const memberId = z.string().regex(/^[\w-]{1,40}$/, 'Invalid member id');
const blankToNull = (v) => (v === '' ? null : v);

export const taskIdParams = z.object({ id: z.string().regex(/^T[\w-]+$/, 'Invalid task id') });

const checklistItem = z.object({ t: z.string().max(500), done: z.boolean().default(false) });
export const checklist = z.array(checklistItem).max(200);

export const listTasksQuery = z.object({
  project: projectId.optional(),
  milestone: milestoneId.optional(),
  assignee: memberId.optional(),
  team: z.enum(TEAMS).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  q: z.string().trim().max(200).optional(),
  chip: z.enum(['overdue', 'week', 'high', 'blocked', 'unassigned', 'mine', '']).optional(),
  sort: z.string().max(30).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const fields = {
  title: z.string().max(300),
  description: z.string().max(10000),
  projectId,
  milestoneId: z.preprocess(blankToNull, milestoneId.nullable()),
  assigneeId: z.preprocess(blankToNull, memberId.nullable()),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(PRIORITIES),
  dueDate: z.preprocess(blankToNull, day.nullable()),
  estimateHours: z.coerce.number().min(0).max(10000),
  checklist,
};

export const createTaskSchema = z.object({
  ...fields,
  title: z.string().max(300).default(''),
  description: fields.description.default(''),
  milestoneId: fields.milestoneId.optional(),
  assigneeId: fields.assigneeId.optional(),
  status: fields.status.default('To do'),
  priority: fields.priority.default('Medium'),
  dueDate: fields.dueDate.optional(),
  estimateHours: fields.estimateHours.default(0),
  checklist: checklist.default([]),
});

export const updateTaskSchema = z.object(fields).partial();

export const checklistSchema = z.object({ checklist });
