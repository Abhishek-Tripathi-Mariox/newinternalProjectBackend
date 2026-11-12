import { ok, created, noContent } from '../../core/http.js';
import * as svc from './integrations.service.js';

export const list = async (req, res) => ok(res, await svc.list(req.user, req.valid.query.projectId));
export const create = async (req, res) => created(res, await svc.create(req.user, req.body));
export const update = async (req, res) => ok(res, await svc.update(req.user, req.valid.params.id, req.body));
export const remove = async (req, res) => { await svc.remove(req.user, req.valid.params.id); noContent(res); };
export const reveal = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, await svc.reveal(req, req.valid.params.id, req.valid.params.credId));
};
