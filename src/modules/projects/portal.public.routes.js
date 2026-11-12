import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { config } from '../../config/index.js';
import { validate } from '../../middleware/validate.js';
import * as ctrl from './portal.controller.js';
import { MILESTONE_ID } from './projects.schemas.js';
import { CR_ID } from '../change-requests/changeRequests.schemas.js';

/** /public/portal/:token — NO auth; the token of an ON portal is the only credential. */
const r = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.isTest ? 10_000 : 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests — try again in a minute' } }),
});
r.use(limiter);

const token = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Invalid portal link');
const tokenParams = z.object({ token });
const msParams = z.object({ token, id: z.string().regex(MILESTONE_ID, 'Invalid milestone id') });
const crParams = z.object({ token, id: z.string().regex(CR_ID, 'Invalid change request id') });
const msDecision = z.object({ approve: z.boolean(), note: z.string().max(5000).optional() });
const crDecision = z.object({ approve: z.boolean(), name: z.string().max(200).optional(), agree: z.boolean().optional(), note: z.string().max(5000).optional() });

r.get('/:token', validate({ params: tokenParams }), ctrl.view);
r.post('/:token/milestones/:id/decision', validate({ params: msParams, body: msDecision }), ctrl.decideMilestone);
r.post('/:token/change-requests/:id/decision', validate({ params: crParams, body: crDecision }), ctrl.decideCr);

export default r;
