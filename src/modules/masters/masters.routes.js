import { Router } from 'express';
import { authorize, requireSuperAdmin } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as s from './masters.schemas.js';
import { listHandlers, getSettings, putSettings } from './masters.controller.js';

const router = Router();
const edit = authorize('leads', 'e'); // Lead setup needs edit rights on leads (frontend canAccessPath)
const p = { params: s.nameParams };

for (const [path, kind] of [['/lead-stages', 'stage'], ['/lead-sources', 'source'], ['/services', 'service']]) {
  const h = listHandlers(kind);
  router.get(path, h.list);
  router.post(path, edit, validate({ body: s.addSchema }), h.add);
  if (kind === 'stage') router.patch(`${path}/:name`, edit, validate({ ...p, body: s.stagePatchSchema }), h.patchStage);
  else router.patch(`${path}/:name`, edit, validate({ ...p, body: s.renameSchema }), h.rename);
  router.post(`${path}/:name/move`, edit, validate({ ...p, body: s.moveSchema }), h.move);
  router.delete(`${path}/:name`, edit, validate(p), h.remove);
}

router.get('/settings', getSettings);
router.put('/settings', requireSuperAdmin, validate({ body: s.settingsSchema }), putSettings);

export default router;
