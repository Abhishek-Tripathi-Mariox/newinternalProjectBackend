import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as s from './users.schemas.js';
import * as ctrl from './users.controller.js';

const router = Router();
const params = { params: s.userIdParams };

router.get('/', authorize('users', 'v'), validate({ query: s.listUsersQuery }), ctrl.list);
router.post('/', authorize('users', 'c'), validate({ body: s.createUserSchema }), ctrl.create);
router.get('/:id', authorize('users', 'v'), validate(params), ctrl.get);
router.patch('/:id', authorize('users', 'e'), validate({ ...params, body: s.updateUserSchema }), ctrl.update);
router.delete('/:id', authorize('users', 'd'), validate(params), ctrl.remove);
router.post('/:id/deactivate', authorize('users', 'e'), validate(params), ctrl.deactivate);
router.post('/:id/reactivate', authorize('users', 'e'), validate(params), ctrl.reactivate);
router.post('/:id/resend-invite', authorize('users', 'c'), validate(params), ctrl.resendInvite);
router.post('/:id/reset-password', authorize('users', 'e'), validate(params), ctrl.resetPassword);
router.post('/:id/force-logout', authorize('users', 'e'), validate(params), ctrl.forceLogout);

export default router;
