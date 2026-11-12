import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as s from './integrations.schemas.js';
import * as ctrl from './integrations.controller.js';

/** /project-integrations — third parties on a project and their (encrypted) credentials. */
const router = Router();

router.get('/', authorize('projects', 'v'), validate({ query: s.projectQuery }), ctrl.list);
router.post('/', authorize('projects', 'v'), validate({ body: s.createSchema }), ctrl.create);
router.patch('/:id', authorize('projects', 'v'), validate({ params: s.idParams, body: s.updateSchema }), ctrl.update);
router.delete('/:id', authorize('projects', 'v'), validate({ params: s.idParams }), ctrl.remove);
router.post('/:id/credentials/:credId/reveal', authorize('projects', 'v'), validate({ params: s.credParams }), ctrl.reveal);

export default router;
