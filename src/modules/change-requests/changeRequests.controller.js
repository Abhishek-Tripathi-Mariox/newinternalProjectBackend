import { ok, created, noContent } from '../../core/http.js';
import * as svc from './changeRequests.service.js';
import { discardUploads } from '../projects/documents.js';

export const list = async (req, res) => {
  const { rows, meta } = await svc.list(req.user, req.valid.query);
  ok(res, rows, meta);
};
export const detail = async (req, res) => ok(res, await svc.detail(req.user, req.valid.params.id));
export const create = async (req, res) => created(res, await svc.create(req.user, req.body));
export const update = async (req, res) => ok(res, await svc.update(req.user, req.valid.params.id, req.body));
export const act = async (req, res) => ok(res, await svc.act(req.user, req.valid.params.id, req.body));
export const remove = async (req, res) => {
  await svc.remove(req.user, req.valid.params.id);
  noContent(res);
};
export const print = async (req, res) => {
  const html = await svc.printHtml(req.user, req.valid.params.id);
  res.type('html').set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com").send(html);
};
export const addDocuments = async (req, res) => {
  try {
    created(res, await svc.addDocuments(req.user, req.valid.params.id, req.files, typeof req.body?.kind === 'string' ? req.body.kind.slice(0, 40) : undefined));
  } catch (e) {
    await discardUploads(req.files);
    throw e;
  }
};
