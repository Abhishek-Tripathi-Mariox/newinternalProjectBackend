import { z } from 'zod';
import { includeParam } from '../../core/include.js';

export const LEAD_ID = /^MX-\d{1,9}$/;
export const QUOTE_ID = /^Q-\d{1,9}-\d{1,4}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const leadId = z.string().regex(LEAD_ID, 'Invalid lead id');
const text = (max) => z.string().max(max);
const day = z.string().regex(DAY_RE, 'Use YYYY-MM-DD');
const optDay = z.union([day, z.literal('')]).optional().transform((v) => v || undefined);
const optStr = (max = 200) => z.string().trim().max(max).optional().transform((v) => v || undefined);

/** services as string[] (also accepts the frontend's "A, B" string). */
const services = z.union([z.array(z.string().trim().min(1).max(100)).max(20), z.string().max(1000)])
  .transform((v) => (Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean)))
  .transform((a) => Array.from(new Set(a)));

export const idParams = z.object({ id: leadId });
export const quoteParams = z.object({ id: leadId, qid: z.string().regex(QUOTE_ID, 'Invalid quote id') });

export const listQuery = z.object({
  q: optStr(),
  status: optStr(),
  owner: optStr(50),
  source: optStr(),
  service: optStr(),
  from: optDay,
  to: optDay,
  flag: z.enum(['hot', 'stale', 'dup', '']).optional().transform((v) => v || undefined),
  staleDays: z.coerce.number().int().min(1).max(365).default(7),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().max(30).optional(),
  include: includeParam(['activities', 'quotes', 'documents']),
});

/** CSV export: the list filters, plus optional `ids=MX-1001,MX-1004` for "export selected". Scope still applies. */
export const exportQuery = listQuery.extend({
  ids: z.string().max(5000).optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .refine((a) => !a || (a.length <= 500 && a.every((x) => LEAD_ID.test(x))), 'Invalid lead ids'),
});

export const createLeadSchema = z.object({
  company: text(200).default(''),
  contact: text(200).default(''),
  email: text(200).default(''),
  phone: text(50).default(''),
  services: services.default([]),
  source: z.string().max(100).optional(),
  ownerId: z.string().max(50).optional(),
  value: z.coerce.number().min(0).max(1e12).default(0),
  notes: text(10000).default(''),
});

export const updateLeadSchema = z.object({
  company: text(200).optional(),
  contact: text(200).optional(),
  email: text(200).optional(),
  phone: text(50).optional(),
  services: services.optional(),
  source: z.string().max(100).optional(),
  ownerId: z.string().max(50).optional(),
  status: z.string().max(100).optional(),
  value: z.coerce.number().min(0).max(1e12).optional(),
  notes: text(10000).optional(),
});

export const statusSchema = z.object({ status: z.string().trim().min(1).max(100) });
export const ownerSchema = z.object({ ownerId: z.string().trim().min(1).max(50) });

export const activitySchema = z.object({
  kind: z.enum(['call', 'email', 'whatsapp', 'meeting', 'note']),
  text: z.string().trim().min(1, 'Write something.').max(2000),
});

export const bulkSchema = z.object({
  ids: z.array(leadId).min(1).max(500),
  owner: z.string().trim().min(1).max(50).optional(),
  status: z.string().trim().min(1).max(100).optional(),
}).refine((b) => !!b.owner !== !!b.status, { message: 'Pass either owner or status', path: ['owner'] });

export const mergeSchema = z.object({ keepId: leadId, dropId: leadId })
  .refine((b) => b.keepId !== b.dropId, { message: 'Pick two different leads', path: ['dropId'] });

export const duplicatesQuery = z.object({
  email: z.string().max(200).default(''),
  phone: z.string().max(50).default(''),
  company: z.string().max(200).default(''),
  excludeId: z.string().max(20).optional(),
});

const quoteItem = z.object({
  d: z.string().max(500).default(''),
  q: z.coerce.number().min(0).max(1e6).default(1),
  r: z.coerce.number().min(0).max(1e12).default(0),
});

export const quoteSchema = z.object({
  items: z.array(quoteItem).max(100).default([]),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  gst: z.boolean().default(true),
  validDays: z.coerce.number().int().min(0).max(3650).default(15),
  terms: text(10000).default(''),
  send: z.boolean().default(false),
});

export const quoteUpdateSchema = z.object({
  items: z.array(quoteItem).max(100).optional(),
  discountPct: z.coerce.number().min(0).max(100).optional(),
  gst: z.boolean().optional(),
  validDays: z.coerce.number().int().min(0).max(3650).optional(),
  terms: text(10000).optional(),
  send: z.boolean().default(false),
});

export const quoteStatusSchema = z.object({ status: z.enum(['Viewed', 'Accepted', 'Declined']) });
