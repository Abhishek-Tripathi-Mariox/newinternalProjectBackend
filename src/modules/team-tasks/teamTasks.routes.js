import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { upload } from '../../middleware/upload.js';
import { forbidden } from '../../core/errors.js';
import { ttPerm } from './teamTasks.service.js';
import * as s from './teamTasks.schemas.js';
import * as ctrl from './teamTasks.controller.js';

/** /team-tasks — tasks given down the "Reports to" hierarchy (independent of projects). Staff only. */
const router = Router();

// Clients never; everyone else needs Team tasks → View.
router.use((req, _res, next) => next(!req.user || req.user.role?.id === 'r-client' || !ttPerm(req.user).v ? forbidden('Your role can’t open Team tasks.') : undefined));

router.get('/', validate({ query: s.listQuery }), ctrl.list);
router.get('/assignees', ctrl.assignees);
router.post('/', validate({ body: s.createSchema }), ctrl.create);
router.get('/:id', validate({ params: s.idParams }), ctrl.get);
router.patch('/:id', validate({ params: s.idParams, body: s.updateSchema }), ctrl.update);
router.post('/:id/attachments', upload.array('files', 10), validate({ params: s.idParams }), ctrl.addAttachments);
router.get('/:id/activity', validate({ params: s.idParams }), ctrl.activity);
router.post('/:id/comments', validate({ params: s.idParams, body: s.commentSchema }), ctrl.comment);
router.delete('/:id', validate({ params: s.idParams }), ctrl.remove);

export default router;
