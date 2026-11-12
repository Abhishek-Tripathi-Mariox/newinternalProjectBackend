import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok } from '../../core/http.js';
import * as svc from './audit.service.js';

const router = Router();

const listQuery = z.object({
  kind: z.enum(['Invite', 'Role', 'Access', 'Profile', 'Credentials']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

async function list(req, res) {
  const { rows, meta } = await svc.list(req.valid.query);
  return ok(res, rows, meta);
}

router.get('/', authorize('users', 'v'), validate({ query: listQuery }), list);

export default router;
