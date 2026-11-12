import { pipeline } from 'node:stream/promises';
import { ok, noContent } from '../../core/http.js';
import { documentsService } from './documents.service.js';

export async function download(req, res) {
  const r = await documentsService.download(req.valid.params.id, req.user);
  res.setHeader('Cache-Control', 'private, no-store');
  // S3 "redirect" mode: hand the browser a short-lived presigned URL instead of proxying bytes.
  if (r.redirect) return res.redirect(302, r.redirect);
  res.setHeader('Content-Type', r.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (r.length != null) res.setHeader('Content-Length', String(r.length));
  res.attachment(r.doc.name);
  // Stream from storage; if the client disconnects, stop reading from S3.
  await pipeline(r.stream, res);
}

export async function setKind(req, res) {
  ok(res, await documentsService.setKind(req.valid.params.id, req.body.kind, req.user));
}

export async function remove(req, res) {
  await documentsService.remove(req.valid.params.id, req.user);
  noContent(res);
}
