import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { upload } from '../../middleware/upload.js';
import * as ctrl from './projects.controller.js';
import * as s from './projects.schemas.js';

const r = Router();

r.get('/', authorize('projects', 'v'), validate({ query: s.listQuery }), ctrl.list);
r.get('/overview', authorize('projects', 'v'), validate({ query: s.overviewQuery }), ctrl.overview);
r.get('/capacity', authorize('projects', 'v'), validate({ query: s.capacityQuery }), ctrl.capacity);
r.post('/', authorize('projects', 'c'), validate({ body: s.createProjectSchema }), ctrl.create);
r.get('/:id', authorize('projects', 'v'), validate({ params: s.projectParams, query: s.detailQuery }), ctrl.detail);
r.patch('/:id', authorize('projects', 'e'), validate({ params: s.projectParams, body: s.updateProjectSchema }), ctrl.update);
r.get('/:id/milestones', authorize('projects', 'v'), validate({ params: s.projectParams }), ctrl.milestones);
r.post('/:id/milestones', authorize('projects', 'e'), validate({ params: s.projectParams, body: s.milestoneInput }), ctrl.addMilestone);
r.post('/:id/members', authorize('projects', 'e'), validate({ params: s.projectParams, body: s.addMemberSchema }), ctrl.addMember);
r.put('/:id/members/:memberId', authorize('projects', 'e'), validate({ params: s.memberParams, body: s.allocSchema }), ctrl.setAlloc);
r.delete('/:id/members/:memberId', authorize('projects', 'e'), validate({ params: s.memberParams }), ctrl.removeMember);
r.put('/:id/links', authorize('projects', 'e'), validate({ params: s.projectParams, body: s.linksSchema }), ctrl.setLinks);
r.post('/:id/portal', authorize('projects', 'e'), validate({ params: s.projectParams, body: s.portalSchema }), ctrl.setPortal);
r.post('/:id/documents', authorize('projects', 'e'), validate({ params: s.projectParams }), upload.array('files', 10), ctrl.addDocuments);

export default r;
