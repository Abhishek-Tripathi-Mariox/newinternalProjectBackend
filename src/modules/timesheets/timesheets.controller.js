import { created, noContent, ok } from '../../core/http.js';
import * as svc from './timesheets.service.js';

export async function list(req, res) {
  const { data, meta } = await svc.list(req.user, req.valid.query);
  ok(res, data, meta);
}
export const summary = async (req, res) => ok(res, await svc.summary(req.user, req.valid.query));
export const matrix = async (req, res) => ok(res, await svc.matrix(req.user, req.valid.query));
export async function exportCsv(req, res) {
  const { csv, filename, count } = await svc.exportCsv(req.user, req.valid.query);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('X-Row-Count', String(count));
  res.send(csv);
}
export async function teamHours(req, res) {
  const { data, meta } = await svc.teamHours(req.user, req.valid.query);
  ok(res, data, meta);
}
export const create = async (req, res) => created(res, await svc.create(req.user, req.body));
export async function remove(req, res) {
  await svc.remove(req.user, req.valid.params.id);
  noContent(res);
}
