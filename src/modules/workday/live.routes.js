import { Router } from 'express';
import { requireSuperAdmin } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as s from './live.schemas.js';
import * as ctrl from './live.controller.js';

/**
 * CEO-only areas (signed-in Super Admin, not previewing): Live now, Attendance, Reports —
 * plus the scoped raw-data reads /live/state, /attendance/events, /shift-reports (any staff).
 * The guard is per route (not router.use) because this router is mounted at '/'.
 */
const router = Router();
const ceo = requireSuperAdmin;
const pid = validate({ params: s.pidParams });

// Raw data in the frontend store shapes — any staff; Super Admin (not previewing) sees everyone,
// everyone else only their own person id (scope applied in the controller).
router.get('/live/state', ctrl.liveState);
router.get('/attendance/events', validate({ query: s.eventsQuery }), ctrl.attendanceEvents);
router.get('/shift-reports', validate({ query: s.shiftReportsQuery }), ctrl.shiftReports);

router.get('/live', ceo, validate({ query: s.liveQuery }), ctrl.live);
router.post('/live/:pid/check-in', ceo, pid, ctrl.action('check-in'));
router.post('/live/:pid/check-out', ceo, pid, ctrl.action('check-out'));
router.post('/live/:pid/break', ceo, pid, validate({ body: s.liveBreakBody }), ctrl.action('break'));
router.post('/live/:pid/resume', ceo, pid, ctrl.action('resume'));
router.post('/live/:pid/timer/start', ceo, pid, validate({ body: s.liveTimerBody }), ctrl.action('timer/start'));
router.post('/live/:pid/timer/stop', ceo, pid, ctrl.action('timer/stop'));

router.get('/attendance', ceo, validate({ query: s.attendanceQuery }), ctrl.attendance);
router.get('/attendance/export.csv', ceo, validate({ query: s.attendanceQuery }), ctrl.attendanceCsv);

router.get('/reports/timeline', ceo, validate({ query: s.timelineQuery }), ctrl.timeline);
router.get('/reports/hours-log', ceo, validate({ query: s.hoursLogQuery }), ctrl.hoursLog);
router.get('/reports/hours-log/export.csv', ceo, validate({ query: s.hoursLogQuery }), ctrl.hoursLogCsv);

export default router;
