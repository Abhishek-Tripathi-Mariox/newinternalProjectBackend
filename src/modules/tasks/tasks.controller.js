import { created, noContent, ok } from '../../core/http.js';
import * as svc from './tasks.service.js';

export async function list(req, res) {
  const { data, meta } = await svc.list(req.user, req.valid.query);
  ok(res, data, meta);
}
export const get = async (req, res) => ok(res, await svc.get(req.user, req.valid.params.id));
export const create = async (req, res) => created(res, await svc.create(req.user, req.body));
export const update = async (req, res) => ok(res, await svc.update(req.user, req.valid.params.id, req.body));
export const setChecklist = async (req, res) => ok(res, await svc.setChecklist(req.user, req.valid.params.id, req.body.checklist));
export async function remove(req, res) {
  await svc.remove(req.user, req.valid.params.id);
  noContent(res);
}
