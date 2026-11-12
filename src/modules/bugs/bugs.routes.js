import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { upload } from '../../middleware/upload.js';
import * as ctrl from './bugs.controller.js';
import { bugIdParams, commentSchema, createBugSchema, listBugsQuery, updateBugSchema } from './bugs.schemas.js';

/** /bugs — bug reports (module 'bugs'). Attachments are documents (entity_type 'bug'). */
const router = Router();
router.get('/', authorize('bugs', 'v'), validate({ query: listBugsQuery }), ctrl.list);
router.post('/', authorize('bugs', 'c'), validate({ body: createBugSchema }), ctrl.create);
router.get('/:id', authorize('bugs', 'v'), validate({ params: bugIdParams }), ctrl.get);
router.patch('/:id', authorize('bugs', 'e'), validate({ params: bugIdParams, body: updateBugSchema }), ctrl.update);
router.post('/:id/comments', authorize('bugs', 'e'), validate({ params: bugIdParams, body: commentSchema }), ctrl.comment);
// 'v' here: the service allows bugs 'e', or bugs 'c' on a bug the user reported.
router.post('/:id/attachments', authorize('bugs', 'v'), upload.array('files', 10), validate({ params: bugIdParams }), ctrl.addAttachments);
router.delete('/:id', authorize('bugs', 'd'), validate({ params: bugIdParams }), ctrl.remove);
export default router;
