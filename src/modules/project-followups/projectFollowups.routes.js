import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as s from './projectFollowups.schemas.js';
import * as ctrl from './projectFollowups.controller.js';
import { forbidden } from '../../core/errors.js';

/** /project-follow-ups — follow-ups on projects; visible to anyone who can see the project. */
const router = Router();

// Internal notes: client accounts (portal users) never see them.
router.use((req, _res, next) => next(req.user?.role?.id === 'r-client' ? forbidden() : undefined));

router.get('/', authorize('projects', 'v'), validate({ query: s.listQuery }), ctrl.list);
router.post('/', authorize('projects', 'v'), validate({ body: s.createSchema }), ctrl.create);
router.get('/:id', authorize('projects', 'v'), validate({ params: s.idParams }), ctrl.get);
router.patch('/:id', authorize('projects', 'v'), validate({ params: s.idParams, body: s.updateSchema }), ctrl.update);
router.patch('/:id/toggle-done', authorize('projects', 'v'), validate({ params: s.idParams }), ctrl.toggleDone);
router.delete('/:id', authorize('projects', 'v'), validate({ params: s.idParams }), ctrl.remove);

export default router;
