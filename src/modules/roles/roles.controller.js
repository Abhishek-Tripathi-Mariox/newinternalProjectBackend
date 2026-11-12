import { ok, created, noContent } from '../../core/http.js';
import * as svc from './roles.service.js';

export const list = async (_req, res) => ok(res, await svc.list());
export const get = async (req, res) => ok(res, await svc.get(req.valid.params.id));
export const create = async (req, res) => created(res, await svc.create(req, req.body));
export const duplicate = async (req, res) => created(res, await svc.duplicate(req, req.valid.params.id));
export const update = async (req, res) => ok(res, await svc.update(req, req.valid.params.id, req.body));
export async function remove(req, res) {
  await svc.remove(req, req.valid.params.id);
  return noContent(res);
}
