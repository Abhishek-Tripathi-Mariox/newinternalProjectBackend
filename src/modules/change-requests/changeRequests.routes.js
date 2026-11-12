import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { upload } from '../../middleware/upload.js';
import * as ctrl from './changeRequests.controller.js';
import * as s from './changeRequests.schemas.js';

/** /change-requests — module key 'projects'; writes are additionally PM-only in the service. */
const r = Router();

r.get('/', authorize('projects', 'v'), validate({ query: s.listQuery }), ctrl.list);
r.post('/', authorize('projects', 'e'), validate({ body: s.createCrSchema }), ctrl.create);
r.get('/:id', authorize('projects', 'v'), validate({ params: s.crParams }), ctrl.detail);
r.get('/:id/print', authorize('projects', 'v'), validate({ params: s.crParams }), ctrl.print);
r.patch('/:id', authorize('projects', 'e'), validate({ params: s.crParams, body: s.updateCrSchema }), ctrl.update);
r.post('/:id/actions', authorize('projects', 'e'), validate({ params: s.crParams, body: s.actionSchema }), ctrl.act);
r.post('/:id/documents', authorize('projects', 'e'), validate({ params: s.crParams }), upload.array('files', 10), ctrl.addDocuments);
r.delete('/:id', authorize('projects', 'e'), validate({ params: s.crParams }), ctrl.remove);

export default r;
