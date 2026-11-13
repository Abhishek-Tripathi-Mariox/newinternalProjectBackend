import { ok, created } from '../../core/http.js';
import * as svc from './projects.service.js';
import { discardUploads } from './documents.js';

export const list = async (req, res) => {
  const { rows, meta } = await svc.list(req.user, req.valid.query);
  ok(res, rows, meta);
};
export const overview = async (req, res) => ok(res, await svc.overview(req.user, req.valid.query));
export const capacity = async (req, res) => ok(res, await svc.capacity(req.user, req.valid.query));
export const detail = async (req, res) => ok(res, await svc.detail(req.user, req.valid.params.id, req.valid.query));
export const allMilestones = async (req, res) => {
  const { rows, meta } = await svc.allMilestones(req.user, req.valid.query);
  ok(res, rows, meta);
};
export const milestones = async (req, res) => ok(res, await svc.milestones(req.user, req.valid.params.id));
export const create = async (req, res) => created(res, await svc.create(req.user, req.body));
export const update = async (req, res) => ok(res, await svc.update(req.user, req.valid.params.id, req.body));
export const setAlloc = async (req, res) => ok(res, await svc.setAlloc(req.user, req.valid.params.id, req.valid.params.memberId, req.body.allocHours, req.body.primary));
export const addMember = async (req, res) => {
  const out = await svc.addMember(req.user, req.valid.params.id, req.body);
  return out.added ? created(res, out) : ok(res, out);
};
export const removeMember = async (req, res) => ok(res, await svc.removeMember(req.user, req.valid.params.id, req.valid.params.memberId));
export const setLinks = async (req, res) => ok(res, await svc.setLinks(req.user, req.valid.params.id, req.body.links));
export const setPortal = async (req, res) => ok(res, await svc.setPortal(req.user, req.valid.params.id, req.body.on));
export const addDocuments = async (req, res) => {
  try {
    created(res, await svc.addDocuments(req.user, req.valid.params.id, req.files, typeof req.body?.kind === 'string' ? req.body.kind.slice(0, 40) : undefined));
  } catch (e) {
    await discardUploads(req.files);
    throw e;
  }
};

export const addMilestone = async (req, res) => created(res, await svc.addMilestone(req.user, req.valid.params.id, req.body));
export const deleteMilestone = async (req, res) => ok(res, await svc.deleteMilestone(req.user, req.valid.params.id));
export const updateMilestone = async (req, res) => ok(res, await svc.updateMilestone(req.user, req.valid.params.id, req.body));
export const askApproval = async (req, res) => ok(res, await svc.askApproval(req.user, req.valid.params.id));

