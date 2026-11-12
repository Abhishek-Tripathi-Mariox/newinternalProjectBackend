/**
 * A person's working day — rules ported from the frontend store (store/slices/workday.js):
 * check-in/out, typed breaks, task timers, heartbeat (presence) and the end-of-shift report.
 * attendance_events is the source of truth; active_timers holds the one running timer per person.
 * All actions take a person id (pid) so both the person themself (/workday) and the CEO (/live/:pid/…)
 * use the same code.
 */
import { db } from '../../db/knex.js';
import { nextId } from '../../core/ids.js';
import { visibleProjectIds } from '../../core/scope.js';
import { notFound, conflict, unprocessable } from '../../core/errors.js';
import * as repo from './workday.repository.js';
import { sumDay, EVL } from './attendance.domain.js';
import { MINUTE, HOUR, sod, addDays, ymd, clock, fmtDur, fmtDate, iso } from './time.js';

export const BREAK_TYPES = { Lunch: 45, 'Tea / coffee': 15, Personal: 15, 'Meeting outside': 30 };

/** Today's attendance state for one person. */
async function dayState(q, pid, now = Date.now()) {
  const T = sod(now);
  const list = await repo.events(q, [pid], T, addDays(T, 1));
  const s = sumDay(list, T, now);
  const lastBreak = s.onBreak ? list.filter((e) => e.k === 'break').at(-1) : null;
  const tm = await repo.timer(q, pid);
  return { T, list, s, checkedIn: s.online || s.onBreak, onBreak: s.onBreak, lastBreak, timer: tm };
}

/** Stop `pid`'s running timer at `t`; logs its time (≥ 1 min) to time_logs and the live feed. */
async function stopTimerAt(q, pid, tm, t) {
  if (!tm) return null;
  const start = new Date(tm.started_at).getTime();
  const mins = (t - start) / MINUTE;
  await repo.deleteTimer(q, pid);
  let log = null;
  if (mins >= 1) {
    log = {
      id: await nextId(q, 'log'), member_id: pid, project_id: tm.project_id, milestone_id: tm.milestone_id, day: ymd(t),
      hours: Math.min(24, Math.max(0.01, Math.round((mins / 60) * 100) / 100)), note: `${tm.title} · timer`, source: 'timer',
    };
    await repo.insertLog(q, log);
  }
  await repo.feed(q, pid, 'stop', `Stopped timer · ${tm.title} · ${fmtDur(t - start)}`, t);
  return log && { id: log.id, projectId: log.project_id, milestoneId: log.milestone_id, day: log.day, hours: log.hours, note: log.note };
}

/** Run `fn(trx, state, t)` serialised per person. */
function act(pid, fn) {
  return db.transaction(async (trx) => {
    await repo.lockPerson(trx, pid);
    const t = Date.now();
    const st = await dayState(trx, pid, t);
    const out = await fn(trx, st, t);
    await repo.touchPresence(trx, pid, t);
    return out;
  });
}

export function checkIn(pid) {
  return act(pid, async (q, st, t) => {
    if (st.checkedIn) throw conflict('Already checked in.');
    await repo.insertEvent(q, pid, 'login', t);
    await repo.feed(q, pid, 'in', 'Checked in', t);
    return { message: 'Checked in', at: iso(t) };
  });
}

/** Check out: ends any open break, stops the timer (logging its time). */
export function checkOut(pid) {
  return act(pid, async (q, st, t) => {
    if (!st.checkedIn) throw unprocessable('You are not checked in.');
    if (st.onBreak) await repo.insertEvent(q, pid, 'resume', t);
    await repo.insertEvent(q, pid, 'logout', t);
    const log = await stopTimerAt(q, pid, st.timer, t);
    await repo.feed(q, pid, 'out', 'Checked out', t + 1);
    return { message: 'Checked out', at: iso(t), log };
  });
}

/** Start a typed break. Stops the running timer. `type` may be null (CEO "Break" button on Live). */
export function startBreak(pid, type = null, note = '') {
  return act(pid, async (q, st, t) => {
    if (!st.checkedIn) throw unprocessable('Check in before taking a break.');
    if (st.onBreak) throw conflict('You are already on a break.');
    const log = await stopTimerAt(q, pid, st.timer, t);
    const planMin = type ? BREAK_TYPES[type] ?? 15 : 0;
    const meta = type ? { type, planMin, note: (note || '').trim() } : {};
    await repo.insertEvent(q, pid, 'break', t, meta);
    await repo.feed(q, pid, 'break', 'Went on break', t + 1);
    return {
      type, planMin, note: meta.note || '', startedAt: iso(t), backBy: planMin ? iso(t + planMin * MINUTE) : null, log,
      message: type ? `${type} break started · back by ${clock(t + planMin * MINUTE)}` : 'Went on break',
    };
  });
}

/** End the current break → { length, overBy } for "Welcome back · 12m break · 3m over". */
export function endBreak(pid) {
  return act(pid, async (q, st, t) => {
    if (!st.onBreak) throw unprocessable('You are not on a break.');
    const len = t - st.lastBreak.t;
    const plan = (st.lastBreak.meta.planMin || 0) * MINUTE;
    const over = plan && len > plan + MINUTE ? len - plan : 0;
    await repo.insertEvent(q, pid, 'resume', t);
    await repo.feed(q, pid, 'break', `Back from break · ${fmtDur(len)}`, t + 1);
    return {
      lengthMs: len, length: fmtDur(len), overMs: over, overBy: over ? fmtDur(over) : null,
      message: `Welcome back · ${fmtDur(len)} break${over ? ` · ${fmtDur(over)} over` : ''}`,
    };
  });
}

/**
 * Start a task timer (stops any running one, logging it). The person must be delivery staff,
 * checked in and not on break. `user` (optional) limits which tasks are visible.
 */
export async function startTimer(pid, taskId, user = null) {
  if (!(await repo.member(db, pid))) throw unprocessable('Timers are for delivery staff.');
  const tk = await repo.task(db, taskId);
  if (!tk) throw notFound('Task');
  if (user && tk.assignee_id !== pid) {
    const ids = await visibleProjectIds(user);
    if (ids && !ids.includes(tk.project_id)) throw notFound('Task');
  }
  return act(pid, async (q, st, t) => {
    if (!st.checkedIn) throw unprocessable('Check in before starting a timer.');
    if (st.onBreak) throw unprocessable('End your break before starting a timer.');
    const log = await stopTimerAt(q, pid, st.timer, t);
    await repo.insertTimer(q, { person_id: pid, task_id: tk.id, project_id: tk.project_id, milestone_id: tk.milestone_id, title: tk.title, started_at: new Date(t) });
    await repo.feed(q, pid, 'start', `Started timer · ${tk.title}`, t + 1);
    return { message: `Timer started · ${tk.title}`, timer: { taskId: tk.id, projectId: tk.project_id, milestoneId: tk.milestone_id, title: tk.title, startedAt: iso(t) }, log };
  });
}

export function stopTimer(pid) {
  return act(pid, async (q, st, t) => {
    if (!st.timer) throw unprocessable('No timer is running.');
    const log = await stopTimerAt(q, pid, st.timer, t);
    return { message: 'Timer stopped · time added to timesheet', log };
  });
}

export async function heartbeat(pid) {
  const t = Date.now();
  await repo.touchPresence(db, pid, t);
  return { at: iso(t) };
}

const timerDto = (tm, now) => (!tm ? null : {
  taskId: tm.task_id, projectId: tm.project_id, projectName: tm.project_name, milestoneId: tm.milestone_id, title: tm.title,
  startedAt: iso(tm.started_at), elapsedMs: now - new Date(tm.started_at).getTime(), elapsed: fmtDur(now - new Date(tm.started_at).getTime()),
});

/** "My day": status, totals, running timer, break plan, today's events. */
export async function me(user) {
  const now = Date.now();
  const pid = user.pid;
  const st = await dayState(db, pid, now);
  const { s, list } = st;
  const lastIn = list.filter((e) => e.k === 'login' || e.k === 'resume').at(-1);
  let status = 'Not checked in';
  let elapsedMs = 0;
  if (st.onBreak) { status = 'On break'; elapsedMs = now - st.lastBreak.t; } else if (s.online) { status = 'Working'; elapsedMs = now - lastIn.t; } else if (list.length) status = 'Checked out';
  let brk = null;
  if (st.onBreak) {
    const m = st.lastBreak.meta || {};
    const plan = (m.planMin || 0) * MINUTE;
    const len = now - st.lastBreak.t;
    brk = {
      type: m.type || null, planMin: m.planMin || 0, note: m.note || '', startedAt: iso(st.lastBreak.t),
      backBy: plan ? iso(st.lastBreak.t + plan) : null, backByLabel: plan ? clock(st.lastBreak.t + plan) : null,
      over: !!plan && len > plan + MINUTE, overMs: plan && len > plan ? len - plan : 0,
    };
  }
  return {
    pid, name: user.name, sales: !user.memberId && !!user.ownerId, day: ymd(now), shiftHours: user.shiftHours,
    status, checkedIn: st.checkedIn, onBreak: st.onBreak, elapsedMs, elapsed: fmtDur(elapsedMs),
    checkedInAt: iso(s.first), checkedOutAt: iso(s.last),
    workedMs: s.work, worked: fmtDur(s.work), workedHours: s.work / HOUR, breakMs: s.br, breakTime: fmtDur(s.br), breaks: s.breaks.length,
    break: brk,
    timer: timerDto(st.timer, now),
    events: list.map((e) => ({ at: iso(e.t), time: clock(e.t), kind: e.k, label: EVL[e.k][0], meta: e.meta })),
    segments: s.segs.map(([k, a, b]) => ({ kind: k === 'w' ? 'work' : 'break', from: iso(a), to: iso(b) })),
  };
}

/** Current milestone of a project: first not Done by n, else the last one. */
function curMs(msList, projectId) {
  const a = msList.filter((m) => m.project_id === projectId);
  return ((a.find((m) => m.status !== 'Done') || a.at(-1)) || {}).id || null;
}

const isSalesPerson = async (q, pid) => !(await repo.member(q, pid)) && !!(await repo.salesOwner(q, pid));

/** Pre-filled end-of-shift form (frontend openEndShift + useEndShiftModel). */
export async function endShiftForm(user) {
  const now = Date.now();
  const pid = user.pid;
  const T = sod(now);
  const st = await dayState(db, pid, now);
  const sales = await isSalesPerson(db, pid);
  const form = {
    who: pid, sales, day: ymd(T), done: '', blockers: '', plan: '', outcome: '', calls: 0, meetings: 0,
    sub: `${user.name} · ${fmtDate(now, { weekday: 'long', day: 'numeric', month: 'short' })}`,
    stats: {
      checkedIn: st.s.first ? clock(st.s.first) : '—', worked: fmtDur(st.s.work),
      breaks: st.s.breaks.length ? `${st.s.breaks.length} · ${fmtDur(st.s.br)}` : 'None', shiftTarget: `${user.shiftHours}h`,
    },
    shift: user.shiftHours, workedHours: st.s.work / HOUR, workedLabel: fmtDur(st.s.work), checkedIn: st.checkedIn,
  };
  if (sales) {
    const acts = (await repo.leadActsSince(db, T)).filter((x) => x.owner === pid);
    const own = acts.filter((x) => !x.fromFeed);
    form.calls = own.filter((a) => a.kind === 'call').length;
    form.meetings = own.filter((a) => a.kind === 'meeting').length;
    const fus = await repo.followUpsFor(db, [pid]);
    const due = (f) => new Date(f.due_at).getTime();
    const fT = fus.filter((f) => due(f) >= T && due(f) < addDays(T, 1));
    const newLeads = await repo.newLeadsSince(db, pid, T);
    form.auto = {
      leadsTouched: new Set(acts.map((x) => x.leadId)).size,
      newLeads: Number(newLeads.n),
      calls: form.calls,
      meetings: form.meetings,
      emails: acts.filter((x) => x.kind === 'email').length,
      quotes: acts.filter((x) => x.kind === 'quote').length,
      followUpsDone: `${fT.filter((f) => f.done).length} / ${fT.length}`,
      dueTomorrow: fus.filter((f) => !f.done && due(f) >= addDays(T, 1) && due(f) < addDays(T, 2)).length,
    };
    return form;
  }
  const [projects, team, todays] = await Promise.all([repo.projects(db), repo.projectTeam(db), repo.logsOn(db, ymd(T), pid)]);
  const mine = new Set(team.filter((x) => x.member_id === pid).map((x) => x.project_id));
  const ids = projects.filter((p) => p.status === 'Running' && mine.has(p.id)).map((p) => p.id);
  todays.forEach((l) => { if (!ids.includes(l.project_id)) ids.push(l.project_id); });
  const tm = st.timer;
  if (tm && !ids.includes(tm.project_id)) ids.push(tm.project_id);
  const ms = await repo.milestonesOf(db, projects.map((p) => p.id));
  form.rows = ids.length ? ids.map((id) => {
    const ls = todays.filter((l) => l.project_id === id);
    const run = tm && tm.project_id === id;
    const h = ls.reduce((x, l) => x + Number(l.hours), 0) + (run ? (now - new Date(tm.started_at).getTime()) / HOUR : 0);
    return {
      p: id, ms: (ls[0] && ls[0].milestone_id) || (run && tm.milestone_id) || curMs(ms, id) || '',
      h: h ? Math.round(h * 4) / 4 : '', note: ls.map((l) => l.note).filter(Boolean).join('; ') || (run ? tm.title : ''),
    };
  }) : [{ p: '', ms: '', h: '', note: '' }];
  form.pmRows = projects.filter((p) => p.pm_member_id === pid && !['Done', 'Completed', 'Cancelled'].includes(p.status)).map((p) => ({ p: p.id, st: 'On track', note: '' }));
  form.projects = projects.filter((p) => (mine.has(p.id) && p.status !== 'Cancelled') || (!mine.has(p.id) && ['Running', 'Planning', 'On hold'].includes(p.status)))
    .map((p) => ({ id: p.id, name: p.name, onTeam: mine.has(p.id) }));
  form.milestones = ms.filter((m) => form.projects.some((p) => p.id === m.project_id)).map((m) => ({ id: m.id, projectId: m.project_id, n: m.n, status: m.status }));
  return form;
}

/**
 * Submit the end-of-shift report (frontend submitEndShift). Logged hours may not exceed time
 * worked today (attendance). Replaces today's time logs with the report rows, upserts the
 * report and checks the person out.
 */
export async function submitEndShift(user, m) {
  const pid = user.pid;
  return db.transaction(async (q) => {
    await repo.lockPerson(q, pid);
    const now = Date.now();
    const T = sod(now);
    const day = ymd(T);
    const st = await dayState(q, pid, now);
    const sales = await isSalesPerson(q, pid);
    let rows = [];
    let ms = [];
    let internal = [];
    if (!sales) {
      rows = (m.rows || []).filter((r) => r.p && +r.h > 0);
      internal = (m.internalRows || []).filter((r) => +r.h > 0);
      if (!rows.length && !internal.length) throw unprocessable('Add hours for at least one project or internal work.');
      const blank = internal.findIndex((r) => !(r.note || '').trim());
      if (blank >= 0) throw unprocessable(`Describe the internal work you did (row ${blank + 1}).`);
      const lt = rows.reduce((x, r) => x + +r.h, 0) + internal.reduce((x, r) => x + +r.h, 0);
      const wh = st.s.work / HOUR;
      if (lt > wh + 0.01) throw unprocessable(`Logged ${Math.round(lt * 100) / 100}h but you worked ${fmtDur(wh * HOUR)}. Reduce hours to match time worked.`);
      if (!m.done.trim()) throw unprocessable('Write what you completed today.');
      const pids = [...new Set(rows.map((r) => r.p))];
      const known = await q('projects').whereIn('id', pids).pluck('id');
      const unknown = pids.filter((p) => !known.includes(p));
      if (unknown.length) throw unprocessable(`Unknown project: ${unknown.join(', ')}`);
      ms = await repo.milestonesOf(q, pids);
    } else if (!m.outcome.trim()) throw unprocessable('Write a short summary of your day.');

    const msOk = (r) => r.ms && ms.some((x) => x.id === r.ms && x.project_id === r.p);
    const repRows = rows.map((r) => {
      const h = Math.round(+r.h * 4) / 4 || Math.round(+r.h * 100) / 100;
      return { p: r.p, ms: msOk(r) ? r.ms : curMs(ms, r.p), h, note: (r.note || '').trim() };
    });
    const pmRows = (m.pmRows || []).map((x) => ({ p: x.p, st: x.st, note: (x.note || '').trim() }));
    const internalRows = internal.map((r) => ({ cat: (r.cat || 'Other').trim() || 'Other', h: Math.round(+r.h * 100) / 100, note: (r.note || '').trim() }));

    // Check out first (ends a break, stops & logs the timer) — then today's logs are replaced.
    const t = now;
    if (st.checkedIn) {
      if (st.onBreak) await repo.insertEvent(q, pid, 'resume', t);
      await repo.insertEvent(q, pid, 'logout', t);
      await stopTimerAt(q, pid, st.timer, t);
      await repo.feed(q, pid, 'out', 'Checked out', t + 1);
    }
    if (!sales) {
      await repo.deleteLogsOn(q, pid, day);
      for (const r of repRows) {
        await repo.insertLog(q, { id: await nextId(q, 'log'), member_id: pid, project_id: r.p, milestone_id: r.ms, day, hours: r.h, note: r.note, source: 'shift-report' });
      }
    }
    await repo.upsertReport(q, {
      person_id: pid, day, is_sales: sales, done: m.done.trim(), blockers: m.blockers.trim(), plan: m.plan.trim(), outcome: m.outcome.trim(),
      calls: +m.calls || 0, meetings: +m.meetings || 0, rows: JSON.stringify(repRows), pm_rows: JSON.stringify(pmRows), internal_rows: JSON.stringify(internalRows), submitted_at: new Date(now),
    });
    await repo.touchPresence(q, pid, now);
    return {
      message: 'Report submitted · shift ended',
      report: { who: pid, day, sales, done: m.done.trim(), blockers: m.blockers.trim(), plan: m.plan.trim(), outcome: m.outcome.trim(), calls: +m.calls || 0, meetings: +m.meetings || 0, rows: repRows, pmRows, internal: internalRows },
    };
  });
}

