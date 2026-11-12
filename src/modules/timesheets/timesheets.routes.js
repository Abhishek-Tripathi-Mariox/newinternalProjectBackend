import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as ctrl from './timesheets.controller.js';
import { createLogSchema, filtersQuery, listLogsQuery, logIdParams, teamHoursQuery } from './timesheets.schemas.js';

/** /time-logs — timesheets (module 'ts'); /time-logs/team-hours is the Team & hours tab (module 'team'). */
const router = Router();
router.get('/', authorize('ts', 'v'), validate({ query: listLogsQuery }), ctrl.list);
router.get('/summary', authorize('ts', 'v'), validate({ query: filtersQuery }), ctrl.summary);
router.get('/matrix', authorize('ts', 'v'), validate({ query: filtersQuery }), ctrl.matrix);
router.get('/export.csv', authorize('ts', 'v'), validate({ query: filtersQuery }), ctrl.exportCsv);
router.get('/team-hours', authorize('team', 'v'), validate({ query: teamHoursQuery }), ctrl.teamHours);
router.post('/', authorize('ts', 'c'), validate({ body: createLogSchema }), ctrl.create);
// Deleting an entry is editing a timesheet: roles with ts 'e' (Team Members fix their own entries).
router.delete('/:id', authorize('ts', 'e'), validate({ params: logIdParams }), ctrl.remove);
export default router;
