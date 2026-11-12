import { ok } from '../../core/http.js';
import * as svc from './workday.service.js';
import { liveState } from './state.service.js';

export const me = async (req, res) => ok(res, await svc.me(req.user));
export const checkIn = async (req, res) => ok(res, await svc.checkIn(req.user.pid));
export const checkOut = async (req, res) => ok(res, await svc.checkOut(req.user.pid));
export const startBreak = async (req, res) => ok(res, await svc.startBreak(req.user.pid, req.body.type, req.body.note));
export const endBreak = async (req, res) => ok(res, await svc.endBreak(req.user.pid));
export const startTimer = async (req, res) => ok(res, await svc.startTimer(req.user.pid, req.body.taskId, req.user));
export const stopTimer = async (req, res) => ok(res, await svc.stopTimer(req.user.pid));
export const heartbeat = async (req, res) => ok(res, await svc.heartbeat(req.user.pid));
export const endShiftForm = async (req, res) => ok(res, await svc.endShiftForm(req.user));
export const submitEndShift = async (req, res) => ok(res, await svc.submitEndShift(req.user, req.body));
/** Same shape as GET /live/state, limited to the caller. */
export const state = async (req, res) => ok(res, await liveState([req.user.pid]));
