/**
 * Pure attendance rules ported from the frontend (domain/attendance.js and
 * features/attendance/shared/attendanceUtils.js). Events are `{ t: epochMs, k: kind, who, meta }`.
 */
import { LATE_MS, sod, addDays, isSunday, parseDay, monthStart, weekday, clock, fmtDur } from './time.js';

/** Group events in [from, to) by `who|day`, each list sorted by time. */
export function groupAttendance(events, from, to) {
  const byPD = {};
  for (const e of events) {
    if (e.t < from || e.t >= to) continue;
    const k = `${e.who}|${sod(e.t)}`;
    (byPD[k] = byPD[k] || []).push(e);
  }
  return byPD;
}

/**
 * Summarise one person's day of attendance events (sorted). For today, open work/break segments
 * run until `now`. Returns {first, last, work, br, breaks:[start,end|null][], segs:['w'|'b',a,b][], online, onBreak}.
 */
export function sumDay(list, d, now = Date.now()) {
  const T = sod(now);
  let first = null;
  let last = null;
  let open = null;
  let brk = null;
  let work = 0;
  let br = 0;
  let online = false;
  let onBreak = false;
  const breaks = [];
  const segs = [];
  list.forEach((e) => {
    if (e.k === 'login') {
      if (first == null) first = e.t;
      if (open == null && brk == null) open = e.t;
    } else if (e.k === 'break' && open != null) {
      work += e.t - open; segs.push(['w', open, e.t]); open = null; brk = e.t;
    } else if (e.k === 'resume' && brk != null) {
      br += e.t - brk; breaks.push([brk, e.t]); segs.push(['b', brk, e.t]); brk = null; open = e.t;
    } else if (e.k === 'logout') {
      if (open != null) { work += e.t - open; segs.push(['w', open, e.t]); open = null; }
      if (brk != null) { br += e.t - brk; breaks.push([brk, e.t]); segs.push(['b', brk, e.t]); brk = null; }
      last = e.t;
    }
  });
  if (d === T && open != null) { work += now - open; segs.push(['w', open, now]); online = true; }
  if (d === T && brk != null) { br += now - brk; breaks.push([brk, null]); segs.push(['b', brk, now]); onBreak = true; }
  return { first, last: online || onBreak ? null : last, work, br, breaks, segs, online, onBreak };
}

export const isLate = (first, day) => !!first && first > day + LATE_MS;
/** A day "counts" once it is in the past or today is past 10:30. */
export const isExpectedDay = (day, T, now) => day < T || now > day + LATE_MS;

export const RANGES = ['today', 'yesterday', 'date', 'week', '7d', 'month', 'lastmonth', '30d'];
export const RANGE_TITLES = { week: 'This week', '7d': 'Last 7 days', month: 'This month', '30d': 'Last 30 days', lastmonth: 'Last month' };
const DAY_PRESETS = ['today', 'yesterday', 'date'];

/** Named period → [from, to). */
function presetRange(preset, T) {
  switch (preset) {
    case '7d': return [addDays(T, -6), addDays(T, 1)];
    case '30d': return [addDays(T, -29), addDays(T, 1)];
    case 'month': return [monthStart(T), monthStart(T, 1)];
    case 'lastmonth': return [monthStart(T, -1), monthStart(T)];
    case 'week': {
      const w = (weekday(T) + 6) % 7;
      return [addDays(T, -w), addDays(T, 7 - w)];
    }
    default: return [addDays(T, -6), addDays(T, 1)];
  }
}

/** Resolve the {range, date} filter to a concrete day / range. */
export function resolveRange({ range: preset, date }, T) {
  const isDay = DAY_PRESETS.includes(preset);
  const day = preset === 'yesterday' ? addDays(T, -1) : preset === 'date' && date ? parseDay(date) : T;
  const rng = isDay ? [day, addDays(day, 1)] : presetRange(preset, T);
  return { isDay, day, rng };
}

/** Working days (Mon–Sat) inside a range, capped at today. Ascending. */
export function workdays(rng, T) {
  const out = [];
  const end = Math.min(rng[1], addDays(T, 1));
  for (let d = rng[0]; d < end; d = addDays(d, 1)) if (!isSunday(d)) out.push(d);
  return out;
}

/** Event labels used by the Attendance view / Reports. */
export const EVL = { login: ['Logged in', 150], logout: ['Logged out', 265], break: ['Started break', 70], resume: ['Back from break', 250] };
const REV = { login: ['Logged in', 150], logout: ['Logged out', 265], break: ['Break', 70], resume: ['Resumed', 250] };
const WORDING = {
  log: { resume: (d) => `after ${d}`, late: 'Late', session: (d) => `session ${d}`, breakLabel: 'Break' },
  pop: { resume: (d) => `Break lasted ${d}`, late: 'Late login', session: (d) => `Session ${d}`, breakLabel: 'Went on break' },
};

/** Narrate a day's events (reports hours log); adds a trailing "Now" item when live. */
export function narrateDay(list, summary, day, now, variant = 'log') {
  const w = WORDING[variant];
  let bs = null;
  let li = null;
  const events = list.map((e) => {
    const v = REV[e.k] || [e.k, 265];
    let sub = '';
    if (e.k === 'break') bs = e.t;
    if (e.k === 'resume' && bs != null) { sub = w.resume(fmtDur(e.t - bs)); bs = null; }
    if (e.k === 'login') {
      li = e.t;
      if (e.t === summary.first && e.t > day + LATE_MS) sub = w.late;
    }
    if (e.k === 'logout' && li != null) { sub = w.session(fmtDur(e.t - li)); li = null; }
    return { at: new Date(e.t).toISOString(), kind: e.k, raw: v[0], label: v[0] === 'Break' ? w.breakLabel : v[0], time: clock(e.t), sub, hue: v[1], now: false };
  });
  if (summary.onBreak) events.push({ at: null, kind: 'now', raw: 'On break', label: 'On break', time: 'Now', sub: `${fmtDur(now - bs)} so far`, hue: 70, now: true });
  else if (summary.online) events.push({ at: null, kind: 'now', raw: 'Working', label: 'Working', time: 'Now', sub: '', hue: 150, now: true });
  return events;
}

/** End-of-shift report as label/value lines (Attendance expanded row). */
export function reportLines(r, projectName) {
  if (!r) return [];
  const L = [];
  if (r.is_sales) {
    L.push(['Activity', `${r.calls} calls · ${r.meetings} meetings`]);
    if (r.outcome) L.push(['Summary', r.outcome]);
  } else {
    if ((r.rows || []).length) L.push(['Hours', r.rows.map((x) => `${projectName(x.p) || ''} ${x.h}h${x.note ? ` (${x.note})` : ''}`).join(' · ')]);
    if ((r.internal_rows || []).length) L.push(['Internal work', r.internal_rows.map((x) => `${x.cat} ${x.h}h${x.note ? ` (${x.note})` : ''}`).join(' · ')]);
    if (r.done) L.push(['Completed', r.done]);
    (r.pm_rows || []).forEach((x) => L.push([projectName(x.p) || 'Project', x.st + (x.note ? ` · ${x.note}` : '')]));
  }
  if (r.blockers) L.push(['Blockers', r.blockers]);
  if (r.plan) L.push(['Tomorrow', r.plan]);
  return L.map(([k, v]) => ({ k, v }));
}

/** Worked-duration flag: 'full' (≥ 8h), 'short' (past day < 6h while present) or ''. */
export function workedFlag(work, day, T, present = true) {
  if (work >= 8 * 36e5) return 'full';
  if (day < T && present && work < 6 * 36e5) return 'short';
  return '';
}

