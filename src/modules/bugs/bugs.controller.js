import { created, noContent, ok } from '../../core/http.js';
import * as svc from './bugs.service.js';

export async function list(req, res) {
  const { data, meta } = await svc.list(req.user, req.valid.query);
  ok(res, data, meta);
}
export const get = async (req, res) => ok(res, await svc.get(req.user, req.valid.params.id));
export const create = async (req, res) => created(res, await svc.create(req.user, req.body));
export const update = async (req, res) => ok(res, await svc.update(req.user, req.valid.params.id, req.body));
export const comment = async (req, res) => created(res, await svc.comment(req.user, req.valid.params.id, req.body.text));
export const addAttachments = async (req, res) => created(res, await svc.addAttachments(req.user, req.valid.params.id, req.files));
export async function remove(req, res) {
  await svc.remove(req.user, req.valid.params.id);
  noContent(res);
}
