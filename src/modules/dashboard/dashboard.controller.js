import { ok } from '../../core/http.js';
import * as svc from './dashboard.service.js';

export async function sales(req, res) {
  ok(res, await svc.sales(req.valid.query, req.user));
}
