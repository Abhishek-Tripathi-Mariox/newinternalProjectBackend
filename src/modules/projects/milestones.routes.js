import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as ctrl from './projects.controller.js';
import * as s from './projects.schemas.js';

/** /milestones — list across visible projects + PM-only edits; GET /projects/:id/milestones lives in projects.routes.js. */
const r = Router();

r.get('/', authorize('projects', 'v'), validate({ query: s.milestonesQuery }), ctrl.allMilestones);
r.patch('/:id', authorize('projects', 'e'), validate({ params: s.milestoneParams, body: s.updateMilestoneSchema }), ctrl.updateMilestone);
r.post('/:id/ask-approval', authorize('projects', 'e'), validate({ params: s.milestoneParams }), ctrl.askApproval);

export default r;
