import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { salesQuery } from './dashboard.schemas.js';
import * as ctrl from './dashboard.controller.js';

/** /dashboard — sales KPIs (module key `dash`). */
const router = Router();

router.get('/sales', authorize('dash', 'v'), validate({ query: salesQuery }), ctrl.sales);

export default router;
