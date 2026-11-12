import { ok, created, noContent } from '../../core/http.js';
import * as svc from './leads.service.js';
import * as quotes from './quotes.service.js';

const ctx = (req) => ({ user: req.user, actor: req.actor });
const P = (req) => req.valid.params;

export async function list(req, res) {
  const { items, meta } = await svc.list(req.valid.query, ctx(req));
  ok(res, items, meta);
}

export async function exportCsv(req, res) {
  const { csv, filename, count } = await svc.exportCsv(req.valid.query, ctx(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Total-Count', String(count));
  res.send(csv);
}

export async function duplicates(req, res) { ok(res, await svc.duplicates(req.valid.query, ctx(req))); }
export async function get(req, res) { ok(res, await svc.get(P(req).id, ctx(req))); }
export async function create(req, res) { created(res, await svc.create(req.body, ctx(req))); }
export async function update(req, res) { ok(res, await svc.update(P(req).id, req.body, ctx(req))); }
export async function setStatus(req, res) { ok(res, await svc.setStatus(P(req).id, req.body.status, ctx(req))); }
export async function setOwner(req, res) { ok(res, await svc.setOwner(P(req).id, req.body.ownerId, ctx(req))); }
export async function addActivity(req, res) { created(res, await svc.addActivity(P(req).id, req.body, ctx(req))); }
export async function bulk(req, res) { ok(res, await svc.bulk(req.body, ctx(req))); }
export async function merge(req, res) { ok(res, await svc.merge(req.body, ctx(req))); }
export async function remove(req, res) { await svc.remove(P(req).id, ctx(req)); noContent(res); }
export async function uploadDocuments(req, res) { created(res, await svc.uploadDocuments(P(req).id, req.files, ctx(req))); }

export async function listQuotes(req, res) { ok(res, await quotes.listQuotes(P(req).id, ctx(req))); }
export async function createQuote(req, res) { created(res, await quotes.saveQuote(P(req).id, null, req.body, ctx(req))); }
export async function updateQuote(req, res) { ok(res, await quotes.saveQuote(P(req).id, P(req).qid, req.body, ctx(req))); }
export async function sendQuote(req, res) { ok(res, await quotes.sendQuote(P(req).id, P(req).qid, ctx(req))); }
export async function setQuoteStatus(req, res) { ok(res, await quotes.setQuoteStatus(P(req).id, P(req).qid, req.body.status, ctx(req))); }

export async function printQuote(req, res) {
  const html = await quotes.printable(P(req).id, P(req).qid, ctx(req));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.send(html);
}
