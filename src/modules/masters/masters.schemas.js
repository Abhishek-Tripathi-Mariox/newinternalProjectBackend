import { z } from 'zod';

export const nameParams = z.object({ name: z.string().min(1).max(80) });
export const addSchema = z.object({ name: z.string().max(80).default('') });
export const renameSchema = z.object({ name: z.string().max(80) });
export const stagePatchSchema = z.object({ name: z.string().max(80).optional(), hue: z.number().int().min(0).max(360).optional() });
export const moveSchema = z.object({ dir: z.union([z.literal(-1), z.literal(1)]) });
export const settingsSchema = z.object({
  currency: z.enum(['INR', 'USD']).optional(),
  defaultLeadsView: z.enum(['Kanban', 'Table']).optional(),
  reminderAlerts: z.boolean().optional(),
}).strict();
