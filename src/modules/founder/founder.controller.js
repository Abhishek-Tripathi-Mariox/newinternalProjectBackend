import { ok } from '../../core/http.js';
import * as service from './founder.service.js';

export async function summary(_req, res) {
  res.set('Cache-Control', 'no-store');
  ok(res, await service.marioxSummary());
}
