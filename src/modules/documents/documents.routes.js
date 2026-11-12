import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { docParams, kindSchema } from './documents.schemas.js';
import * as ctrl from './documents.controller.js';

/**
 * /documents — permissions are checked against the parent entity in the service
 * (lead → leads, project/cr → projects, bug → bugs; view for download, edit for changes).
 * Uploads happen on the parent's routes (e.g. POST /leads/:id/documents).
 */
const router = Router();

router.get('/:id/download', validate({ params: docParams }), ctrl.download);
router.patch('/:id', validate({ params: docParams, body: kindSchema }), ctrl.setKind);
router.delete('/:id', validate({ params: docParams }), ctrl.remove);

export default router;
