import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as s from './roles.schemas.js';
import * as ctrl from './roles.controller.js';

const router = Router();
const params = { params: s.roleIdParams };

router.get('/', authorize('users', 'v'), ctrl.list);
router.post('/', authorize('users', 'c'), validate({ body: s.createRoleSchema }), ctrl.create);
router.get('/:id', authorize('users', 'v'), validate(params), ctrl.get);
router.post('/:id/duplicate', authorize('users', 'c'), validate(params), ctrl.duplicate);
router.patch('/:id', authorize('users', 'e'), validate({ ...params, body: s.updateRoleSchema }), ctrl.update);
router.delete('/:id', authorize('users', 'd'), validate(params), ctrl.remove);

export default router;
