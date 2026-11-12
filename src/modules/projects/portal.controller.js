import { ok } from '../../core/http.js';
import * as svc from './portal.service.js';

export const view = async (req, res) => ok(res, await svc.view(req.valid.params.token));
export const decideMilestone = async (req, res) => ok(res, await svc.decideMilestone(req.valid.params.token, req.valid.params.id, req.body));
export const decideCr = async (req, res) => ok(res, await svc.decideCr(req.valid.params.token, req.valid.params.id, req.body));
