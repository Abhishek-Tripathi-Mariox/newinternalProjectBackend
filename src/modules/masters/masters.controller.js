import { ok, created, noContent } from '../../core/http.js';
import * as svc from './masters.service.js';

/** Handlers for one list kind ('stage' | 'source' | 'service'). */
export const listHandlers = (kind) => ({
  list: async (_req, res) => ok(res, await svc.list(kind)),
  add: async (req, res) => {
    const r = await svc.add(kind, req.body.name);
    return r.created ? created(res, r.item) : ok(res, r.item);
  },
  rename: async (req, res) => {
    const to = await svc.rename(kind, req.valid.params.name, req.body.name);
    return ok(res, (await svc.list(kind)).find((x) => x.name === to));
  },
  patchStage: async (req, res) => ok(res, await svc.patchStage(req.valid.params.name, req.body)),
  move: async (req, res) => ok(res, await svc.move(kind, req.valid.params.name, req.body.dir)),
  remove: async (req, res) => {
    await svc.remove(kind, req.valid.params.name);
    return noContent(res);
  },
});

export const getSettings = async (_req, res) => ok(res, await svc.getSettings());
export const putSettings = async (req, res) => ok(res, await svc.putSettings(req.body));
