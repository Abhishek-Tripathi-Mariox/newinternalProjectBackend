import { ok, created, noContent } from '../../core/http.js';
import * as svc from './users.service.js';

export async function list(req, res) {
  const { rows, meta } = await svc.list(req.valid.query);
  return ok(res, rows, meta);
}
export const get = async (req, res) => ok(res, await svc.get(req.valid.params.id));
export const create = async (req, res) => created(res, await svc.create(req, req.body));
export const update = async (req, res) => ok(res, await svc.update(req, req.valid.params.id, req.body));
export const deactivate = async (req, res) => ok(res, await svc.setStatus(req, req.valid.params.id, 'Deactivated'));
export const reactivate = async (req, res) => ok(res, await svc.setStatus(req, req.valid.params.id, 'Active'));
export async function remove(req, res) {
  await svc.remove(req, req.valid.params.id);
  return noContent(res);
}
export const resendInvite = async (req, res) => ok(res, await svc.resendInvite(req, req.valid.params.id));
export const resetPassword = async (req, res) => ok(res, await svc.resetPassword(req, req.valid.params.id));
export const forceLogout = async (req, res) => ok(res, await svc.forceLogout(req, req.valid.params.id));
