import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as s from './followups.schemas.js';
import * as ctrl from './followups.controller.js';

/** /follow-ups — meetings, calls, tasks and reminders (module key `fu`). */
const router = Router();

router.get('/', authorize('fu', 'v'), validate({ query: s.listQuery }), ctrl.list);
router.get('/due-reminders', authorize('fu', 'v'), ctrl.dueReminders);
router.post('/due-reminders/ack', authorize('fu', 'v'), validate({ body: s.ackSchema }), ctrl.ackReminders);
router.post('/', authorize('fu', 'c'), validate({ body: s.createSchema }), ctrl.create);
router.get('/:id', authorize('fu', 'v'), validate({ params: s.idParams }), ctrl.get);
router.patch('/:id', authorize('fu', 'e'), validate({ params: s.idParams, body: s.updateSchema }), ctrl.update);
router.patch('/:id/toggle-done', authorize('fu', 'e'), validate({ params: s.idParams }), ctrl.toggleDone);
router.delete('/:id', authorize('fu', 'd'), validate({ params: s.idParams }), ctrl.remove);

export default router;
