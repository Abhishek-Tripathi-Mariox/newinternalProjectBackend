import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok } from '../../core/http.js';
import * as svc from './people.service.js';

const router = Router();

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const idParams = z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/i, 'Invalid id') });
const membersQuery = z.object({ team: z.enum(['Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO']).optional(), active: bool.optional(), q: z.string().trim().max(100).optional() });
const ownersQuery = z.object({ active: bool.optional() });
const patchMember = z.object({
  shiftHours: z.number().min(1).max(24).optional(),
  costPerHour: z.number().min(0).max(1_000_000).nullable().optional(),
}).strict();

// Directory reads: any signed-in user (dropdowns everywhere need names).
router.get('/members', validate({ query: membersQuery }), async (req, res) => ok(res, await svc.listMembers(req.valid.query)));
router.get('/members/:id', validate({ params: idParams }), async (req, res) => ok(res, await svc.getMember(req.valid.params.id)));
router.patch('/members/:id', authorize('users', 'e'), validate({ params: idParams, body: patchMember }), async (req, res) => ok(res, await svc.updateMember(req.valid.params.id, req.body)));
router.get('/sales-owners', validate({ query: ownersQuery }), async (req, res) => ok(res, await svc.listOwners(req.valid.query)));

export default router;
