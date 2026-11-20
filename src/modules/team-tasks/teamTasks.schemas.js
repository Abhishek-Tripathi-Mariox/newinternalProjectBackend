import { z } from 'zod';

export const TT_ID = /^TT\d{1,9}$/;
export const TT_STATUSES = ['To do', 'In progress', 'Reopened', 'Done'];
export const TT_PRIORITIES = ['High', 'Medium', 'Low'];

const USER_ID = z.string().regex(/^u-[a-z0-9-]{1,40}$/i, 'Pick who this task is for');
const projectId = z.union([z.string().regex(/^PR-\d{1,9}$/, 'Pick a project'), z.literal(''), z.null()]).optional();
const leadId = z.union([z.string().regex(/^MX-\d{1,9}$/, 'Pick a lead'), z.literal(''), z.null()]).optional();
const estimate = z.union([z.coerce.number().min(0, 'Hours can’t be negative').max(1000, 'Keep the estimate under 1000h'), z.literal(''), z.null()]).optional();
const due = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'), z.literal(''), z.null()]).optional();

export const idParams = z.object({ id: z.string().regex(TT_ID, 'Invalid task id') });

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(1000).optional(),
});

export const createSchema = z.object({
  title: z.string().trim().min(1, 'Add a title.').max(300),
  notes: z.string().max(10000).optional(),
  priority: z.enum(TT_PRIORITIES).optional(),
  status: z.enum(TT_STATUSES).exclude(['Reopened']).optional(), // a new task can't start reopened
  dueDate: due,
  estimateHours: estimate,
  projectId,
  leadId,
  assigneeId: USER_ID,
});

export const updateSchema = z.object({
  title: z.string().trim().min(1, 'Add a title.').max(300).optional(),
  notes: z.string().max(10000).optional(),
  priority: z.enum(TT_PRIORITIES).optional(),
  status: z.enum(TT_STATUSES).optional(),
  dueDate: due,
  estimateHours: estimate,
  projectId,
  leadId,
  assigneeId: USER_ID.optional(),
  updateNote: z.string().max(5000).optional(),
  comment: z.string().max(5000).optional(), // why (required when reopening a Done task)
}).refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const commentSchema = z.object({ text: z.string().trim().min(1, 'Write a comment.').max(5000) });
