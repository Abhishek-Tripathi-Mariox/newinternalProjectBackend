import { ok, created, noContent } from '../../core/http.js';
import * as svc from './teamTasks.service.js';

const id = (req) => req.valid.params.id;

export async function list(req, res) {
  const { items, meta } = await svc.list(req.valid.query, req.user);
  ok(res, items, meta);
}
export async function assignees(req, res) { ok(res, await svc.assignees(req.user)); }
export async function get(req, res) { ok(res, await svc.get(id(req), req.user)); }
export async function create(req, res) { created(res, await svc.create(req.body, req.user)); }
export async function update(req, res) { ok(res, await svc.update(id(req), req.body, req.user)); }
export async function addAttachments(req, res) { created(res, await svc.addAttachments(id(req), req.files, req.user, typeof req.body?.title === 'string' ? req.body.title : '')); }
export async function remove(req, res) { await svc.remove(id(req), req.user); noContent(res); }
export async function activity(req, res) { ok(res, await svc.activity(id(req), req.user)); }
export async function comment(req, res) { created(res, await svc.comment(id(req), req.body.text, req.user)); }
