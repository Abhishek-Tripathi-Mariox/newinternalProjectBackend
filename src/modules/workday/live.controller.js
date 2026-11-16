import { ok } from '../../core/http.js';
import * as svc from './live.service.js';
import * as state from './state.service.js';
import { forbidden, unprocessable } from '../../core/errors.js';

const sendCsv = (res, { rows, name }) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(svc.toCsv(rows));
};

export const live = async (req, res) => ok(res, await svc.live(req.valid.query));
/** POST /live/:pid/<action> — the action name is fixed per route (see live.routes.js). */
export const action = (name) => async (req, res) => ok(res, await svc.liveAction(req.valid.params.pid, name, req.body || {}));
export const attendance = async (req, res) => ok(res, await svc.attendance(req.valid.query));
export const attendanceCsv = async (req, res) => sendCsv(res, await svc.attendanceCsv(req.valid.query));
export const timeline = async (req, res) => ok(res, await svc.timeline(req.valid.query));
export const hoursLog = async (req, res) => ok(res, await svc.hoursLog(req.valid.query));
export const hoursLogCsv = async (req, res) => sendCsv(res, await svc.hoursLogCsv(req.valid.query));

/**
 * Whose raw workday data the caller may read: null = everyone (signed-in Super Admin, not
 * previewing; narrowed by ?person=). Anyone else: their own pid plus the people who report to
 * them ("Reports to", direct or indirect); ?person= narrows to one of those (anyone else is
 * forced back to their own pid). Clients and accounts without a person id get 403.
 */
export function scopePids(req, person) {
  if (req.user.isSuper && !req.previewing) return person ? [person] : null;
  if (req.user.role.id === 'r-client' || !req.user.pid) throw forbidden('Clients have no workday');
  const mine = [req.user.pid, ...(req.user.reportees || []).map((r) => r.pid)];
  if (person) return mine.includes(person) ? [person] : [req.user.pid];
  return mine;
}

/** Own live state only (the header's check-in / break / timer controls). */
export const liveState = async (req, res) => ok(res, await state.liveState(scopePids(req, req.user.isSuper && !req.previewing ? undefined : req.user.pid)));

export const attendanceEvents = async (req, res) => {
  const { from, to, person } = req.valid.query;
  const rng = state.dayRange(from, to);
  if (rng[1] <= rng[0]) throw unprocessable('"from" must be on or before "to".');
  if (state.rangeTooLong(rng)) throw unprocessable(`Pick a range of at most ${state.MAX_RANGE_DAYS} days.`);
  ok(res, await state.attendanceEvents(scopePids(req, person), rng));
};

export const shiftReports = async (req, res) => {
  const { from, to, person } = req.valid.query;
  if (from && to && from > to) throw unprocessable('"from" must be on or before "to".');
  ok(res, await state.shiftReports(scopePids(req, person), { from, to }));
};
