import { z } from 'zod';

export const userIdParams = z.object({ id: z.string().regex(/^u-[a-z0-9-]{1,40}$/i, 'Invalid user id') });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const roleId = z.string().regex(/^r-[a-z0-9-]{1,40}$/i, 'Invalid role id');

export const listUsersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: roleId.optional(),
  dept: z.string().max(60).optional(),
  status: z.enum(['Active', 'Invited', 'Deactivated']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().max(40).optional(),
});

// name / email are checked in the service so the messages match the frontend form.
const fields = {
  name: z.string().max(120),
  email: z.string().max(254),
  phone: z.string().trim().max(40),
  title: z.string().trim().max(120),
  role: roleId,
  dept: z.string().trim().max(60),
  reportsTo: z.string().regex(/^u-[a-z0-9-]{1,40}$/i).nullable(),
  joinDate: day.nullable(),
  shiftHours: z.coerce.number().min(1).max(24),
  clientOf: z.array(z.string().regex(/^PR-\d+$/)).max(50),
};

export const createUserSchema = z.object({
  ...fields,
  name: fields.name.default(''),
  email: fields.email.default(''),
  sendInvite: z.boolean().default(true),
  password: z.string().min(8, 'Use at least 8 characters.').max(128).optional(),
}).partial({ phone: true, title: true, dept: true, reportsTo: true, joinDate: true, shiftHours: true, clientOf: true });

export const updateUserSchema = z.object(fields).partial();
