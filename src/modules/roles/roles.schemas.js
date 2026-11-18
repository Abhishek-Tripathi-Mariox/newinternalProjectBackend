import { z } from 'zod';

/** `tt` = Team tasks: All = every task / give to anyone, Team = self + people who report to them, Own = own tasks only. */
/** `att` = Attendance & reports (view only): All = everyone, Team = self + people who report to them, Own = self. */
export const MODS = ['dash', 'leads', 'fu', 'projects', 'tasks', 'bugs', 'ts', 'team', 'users', 'att', 'tt'];

export const roleIdParams = z.object({ id: z.string().regex(/^r-[a-z0-9-]{1,40}$/i, 'Invalid role id') });

const cell = z.object({
  v: z.boolean().optional(),
  c: z.boolean().optional(),
  e: z.boolean().optional(),
  d: z.boolean().optional(),
  scope: z.enum(['all', 'team', 'own']).optional(),
}).strict();

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).optional(),
});

/** perms is a patch: only the modules / actions given change, then the frontend toggle rules apply. */
export const updateRoleSchema = z.object({
  name: z.string().trim().min(1, 'Enter a role name.').max(60).optional(),
  description: z.string().trim().max(200).optional(),
  hue: z.number().int().min(0).max(360).optional(),
  perms: z.partialRecord(z.enum(MODS), cell).optional(),
});
