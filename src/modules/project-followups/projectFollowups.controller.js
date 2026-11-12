import { ok, created, noContent } from '../../core/http.js';
import * as svc from './projectFollowups.service.js';

const id = (req) => req.valid.params.id;

export async function list(req, res) {
  const { items, meta } = await svc.list(req.valid.query, req.user);
  ok(res, items, meta);
}
export async function get(req, res) { ok(res, await svc.get(id(req), req.user)); }
export async function create(req, res) { created(res, await svc.create(req.body, req.user)); }
export async function update(req, res) { ok(res, await svc.update(id(req), req.body, req.user)); }
export async function toggleDone(req, res) { ok(res, await svc.toggleDone(id(req), req.user)); }
export async function remove(req, res) { await svc.remove(id(req), req.user); noContent(res); }
