import { z } from 'zod';
import { PROJECT_ID } from '../projects/projects.schemas.js';

export const CATEGORIES = ['Payment gateway', 'SMS / WhatsApp', 'Email', 'Maps / location', 'Cloud / hosting', 'Login / auth', 'Push notifications',
  'Analytics', 'App Store / Play Store', 'Domain / DNS', 'Other'];
export const STATUSES = ['Pending from client', 'Received', 'Integrated', 'Live'];
export const ENVS = ['Live', 'Test', 'Both'];

const idNum = z.coerce.number().int().positive();
export const projectQuery = z.object({ projectId: z.string().regex(PROJECT_ID, 'Invalid project id') });
export const idParams = z.object({ id: idNum });
export const credParams = z.object({ id: idNum, credId: idNum });

const cred = z.object({
  id: idNum.optional(), // existing credential (edit); omit for a new one
  label: z.string().trim().min(1, 'Name each credential (e.g. API key)').max(80),
  env: z.enum(ENVS).default('Live'),
  value: z.string().max(5000).optional(), // new value; omit / '' on an existing one to keep it
});

const fields = {
  name: z.string().trim().min(1, 'Enter the third party name').max(120),
  category: z.enum(CATEGORIES).default('Other'),
  status: z.enum(STATUSES).default('Pending from client'),
  url: z.string().trim().max(500).refine((v) => !v || /^https?:\/\//i.test(v), 'The link must start with https://').default(''),
  notes: z.string().max(5000).default(''),
  credentials: z.array(cred).max(30).optional(),
};

export const createSchema = z.object({ projectId: z.string().regex(PROJECT_ID, 'Invalid project id'), ...fields });
export const updateSchema = z.object({
  name: fields.name.optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(STATUSES).optional(),
  url: z.string().trim().max(500).refine((v) => !v || /^https?:\/\//i.test(v), 'The link must start with https://').optional(),
  notes: z.string().max(5000).optional(),
  credentials: fields.credentials, // when given: the full list (missing ids are deleted)
}).refine((b) => Object.keys(b).length > 0, 'Nothing to update');
