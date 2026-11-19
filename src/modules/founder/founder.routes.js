import { Router } from 'express';
import { founderKey } from './founder.auth.js';
import * as ctrl from './founder.controller.js';

/**
 * /founder — read-only numbers for the cofounder portal. Not behind user login: callers send the
 * shared FOUNDER_API_KEY in `x-founder-key` (server-to-server or through a proxy, never from a browser).
 */
const router = Router();
router.get('/summary', founderKey, ctrl.summary);
export default router;
