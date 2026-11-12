import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { forbidden } from '../../core/errors.js';
import { breakSchema, timerStartSchema, endShiftSchema } from './workday.schemas.js';
import * as ctrl from './workday.controller.js';

/** Staff only (clients have no workday). */
function staffOnly(req, _res, next) {
  if (req.user.role.id === 'r-client' || !req.user.pid) throw forbidden('Clients have no workday');
  next();
}
/** A Super Admin previewing someone may look at their day but not change it. */
function notPreviewing(req, _res, next) {
  if (req.previewing) throw forbidden('Exit preview to change attendance');
  next();
}

const router = Router();
router.use(staffOnly);
router.get('/me', ctrl.me);
router.get('/my-day', ctrl.me);
router.get('/state', ctrl.state);
router.post('/check-in', notPreviewing, ctrl.checkIn);
router.post('/check-out', notPreviewing, ctrl.checkOut);
router.post('/break', notPreviewing, validate({ body: breakSchema }), ctrl.startBreak);
router.post('/break/end', notPreviewing, ctrl.endBreak);
router.post('/timer/start', notPreviewing, validate({ body: timerStartSchema }), ctrl.startTimer);
router.post('/timer/stop', notPreviewing, ctrl.stopTimer);
router.post('/heartbeat', notPreviewing, ctrl.heartbeat);
router.get('/end-shift', ctrl.endShiftForm);
router.post('/end-shift', notPreviewing, validate({ body: endShiftSchema }), ctrl.submitEndShift);

export default router;
