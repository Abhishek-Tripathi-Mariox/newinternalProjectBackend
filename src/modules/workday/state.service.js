/**
 * Raw workday data in the frontend store shapes (CONTRACT.md "Data shapes"), so the React app can
 * run its own Live / Attendance / Reports builders on API data:
 *   - liveState      → `live`    {date, att, timers, idle, feed}
 *   - attendanceEvents → `attLog` rows [{at, personId, kind, meta}]
 *   - shiftReports   → `reports` [{id, who, d, t, sales, done, blockers, plan, outcome, calls, meetings, rows, pm}]
 * Scope: `pids` = null → everyone (Super Admin not previewing), otherwise only those person ids.
 * All timestamps are ISO strings; calendar days 'YYYY-MM-DD' (business time zone).
 */
import { db } from '../../db/knex.js';
import * as repo from './workday.repository.js';
import { sumDay, groupAttendance } from './attendance.domain.js';
import { MINUTE, DAY, sod, addDays, parseDay, ymd, iso } from './time.js';

export const IDLE_MS = 30 * MINUTE;
/** Longest from–to span accepted by the range endpoints. */
export const MAX_RANGE_DAYS = 400;

const only = (pids) => (pids ? (id) => pids.includes(id) : () => true);

/** Today's attendance summary per person, like the frontend live.att entry. */
function attOf(list, T, now) {
  const s = sumDay(list, T, now);
  const lastBreak = s.onBreak ? list.filter((e) => e.k === 'break').at(-1) : null;
  const doneBreakMs = s.breaks.filter(([, end]) => end != null).reduce((x, [a, b]) => x + (b - a), 0);
  const m = (lastBreak && lastBreak.meta) || {};
  return {
    in: iso(s.first),
    out: s.online || s.onBreak ? null : iso(s.last),
    brk: lastBreak ? iso(lastBreak.t) : null,
    brkMin: Math.round((doneBreakMs / MINUTE) * 100) / 100,
    brkType: m.type || null,
    brkPlan: m.planMin || 0,
    brkNote: m.note || '',
  };
}

/**
 * GET /live/state, /workday/state → `{date, att:{pid:{in,out,brk,brkMin,brkType,brkPlan,brkNote}},
 * timers:{pid:{task,p,ms,title,start}}, idle:{pid:t}, feed:[{t,who,kind,text,lead,source}]}`.
 * `att` has an entry only for people with attendance events today; `idle` lists people whose last
 * activity is ≥ 30 min ago; `feed` = today's activity_feed lines (source 'feed', `lead` set when a
 * line references a lead) + today's lead_activities (source 'lead', who = lead owner), oldest first.
 */
export async function liveState(pids, now = Date.now()) {
  const T = sod(now);
  const end = addDays(T, 1);
  const keep = only(pids);
  const [evs, tms, pres, feedRows, acts] = await Promise.all([
    repo.events(db, pids, T, end),
    repo.timers(db),
    repo.presenceMap(db),
    (() => {
      const qb = db('activity_feed').where('at', '>=', new Date(T)).where('at', '<', new Date(end)).orderBy([{ column: 'at' }, { column: 'id' }])
        .select('person_id', 'kind', 'text', 'lead_id', 'at');
      if (pids) qb.whereIn('person_id', pids.length ? pids : ['__none__']);
      return qb;
    })(),
    (() => {
      const qb = db('lead_activities as a').join('leads as l', 'l.id', 'a.lead_id').where('a.at', '>=', new Date(T)).where('a.at', '<', new Date(end))
        .orderBy([{ column: 'a.at' }, { column: 'a.id' }]).select('a.at', 'a.kind', 'a.text', 'a.lead_id', 'l.owner_id');
      if (pids) qb.whereIn('l.owner_id', pids.length ? pids : ['__none__']);
      return qb;
    })(),
  ]);

  const byP = groupAttendance(evs, T, end);
  const att = {};
  for (const [k, list] of Object.entries(byP)) att[k.split('|')[0]] = attOf(list, T, now);

  const timers = {};
  for (const t of tms) {
    if (!keep(t.person_id)) continue;
    timers[t.person_id] = { task: t.task_id, p: t.project_id, ms: t.milestone_id, title: t.title, start: iso(t.started_at) };
  }

  const idle = {};
  for (const [pid, t] of Object.entries(pres)) if (keep(pid) && now - t >= IDLE_MS) idle[pid] = iso(t);

  const feed = feedRows.map((f) => ({ t: iso(f.at), who: f.person_id, kind: f.kind, text: f.text, lead: f.lead_id || null, source: 'feed' }))
    .concat(acts.map((a) => ({ t: iso(a.at), who: a.owner_id, kind: a.kind, text: a.text, lead: a.lead_id, source: 'lead' })))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  return { date: ymd(T), att, timers, idle, feed };
}

/** Resolve optional from/to 'YYYY-MM-DD' (inclusive) to [fromMs, toMs); defaults to today. */
export function dayRange(from, to, now = Date.now()) {
  const T = sod(now);
  const a = from ? parseDay(from) : to ? parseDay(to) : T;
  const b = addDays(to ? parseDay(to) : from ? parseDay(from) : T, 1);
  return [a, b];
}

/** GET /attendance/events → [{at, personId, kind, meta}] oldest first, in [from, to] (days, inclusive). */
export async function attendanceEvents(pids, rng) {
  const evs = await repo.events(db, pids, rng[0], rng[1]);
  return evs.map((e) => ({ at: iso(e.t), personId: e.who, kind: e.k, meta: e.meta || {} }));
}

/**
 * GET /shift-reports → reports in the frontend shape, oldest day first. from/to are optional
 * inclusive 'YYYY-MM-DD' bounds (none = all).
 */
export async function shiftReports(pids, { from, to } = {}) {
  const qb = db('shift_reports').orderBy([{ column: 'day' }, { column: 'submitted_at' }, { column: 'id' }]);
  if (pids) qb.whereIn('person_id', pids.length ? pids : ['__none__']);
  if (from) qb.where('day', '>=', from);
  if (to) qb.where('day', '<=', to);
  const rows = await qb.select('*');
  return rows.map((r) => ({
    id: `R${r.id}`,
    who: r.person_id,
    d: typeof r.day === 'string' ? r.day : ymd(new Date(r.day).getTime()),
    t: iso(r.submitted_at),
    sales: r.is_sales,
    done: r.done,
    blockers: r.blockers,
    plan: r.plan,
    outcome: r.outcome,
    calls: r.calls,
    meetings: r.meetings,
    rows: (r.rows || []).map((x) => ({ p: x.p, ms: x.ms ?? null, h: Number(x.h) || 0, note: x.note || '' })),
    pm: (r.pm_rows || []).map((x) => ({ p: x.p, st: x.st, note: x.note || '' })),
    internal: (r.internal_rows || []).map((x) => ({ cat: x.cat || 'Other', h: Number(x.h) || 0, note: x.note || '' })),
  }));
}

export const rangeTooLong = (rng) => rng[1] - rng[0] > MAX_RANGE_DAYS * DAY + 2 * 36e5;
