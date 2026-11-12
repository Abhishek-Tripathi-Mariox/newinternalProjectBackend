/**
 * CEO views (Super Admin only): Live now, Attendance and Reports — ported from the frontend
 * builders (features/live/useLiveModel.js, features/attendance/useAttendanceModel.js,
 * features/reports/useReportsModel.js). Presentation colours are left to the client; we return
 * the same labels, keys, hues and numbers.
 */
import { db } from '../../db/knex.js';
import { notFound } from '../../core/errors.js';
import * as repo from './workday.repository.js';
import * as wd from './workday.service.js';
import {
  sumDay, groupAttendance, isLate, isExpectedDay, resolveRange, workdays, narrateDay, reportLines, workedFlag, EVL, RANGE_TITLES,
} from './attendance.domain.js';
import { MINUTE, HOUR, DAY, LATE_MS, sod, parseDay, addDays, ymd, weekday, isSunday, clock, fmtDate, fmtDur, h1, iso } from './time.js';

const ORD = { absent: 0, idle: 1, notimer: 2, break: 3, work: 4, off: 5 };
const LIVE_FILTERS = {
  all: () => true,
  attention: (x) => ['absent', 'idle', 'notimer'].includes(x.key),
  work: (x) => x.key === 'work',
  break: (x) => x.key === 'break',
  delivery: (x) => !x.sales,
  sales: (x) => x.sales,
  absent: (x) => x.key === 'absent',
  idle: (x) => x.key === 'idle',
};
const LIVE_CHIPS = [['all', 'Everyone'], ['attention', 'Needs attention'], ['work', 'Working'], ['break', 'On break'], ['delivery', 'Delivery'], ['sales', 'Sales']];
const FK = { in: 265, out: 265, start: 250, stop: 250, break: 70, call: 150, email: 250, whatsapp: 150, meeting: 300, note: 85, quote: 35, status: 265, owner: 220, appr: 150 };

/* ───────────── Live now ───────────── */

export async function live({ filter = 'all', feed: feedF = 'all' } = {}) {
  const now = Date.now();
  const T = sod(now);
  const LATE = T + LATE_MS;
  const pastLate = !isSunday(T) && now > LATE;
  const [ppl, evs, tms, pres, logs, acts, teamFeed, approvals, openTasks] = await Promise.all([
    repo.people(db), repo.events(db, null, T, addDays(T, 1)), repo.timers(db), repo.presenceMap(db), repo.logsOn(db, ymd(T)),
    repo.leadActsSince(db, T), repo.teamFeedSince(db, T), repo.approvalsSince(db, T),
    db('tasks as t').join('projects as p', 'p.id', 't.project_id').whereNotNull('t.assignee_id').whereNot('t.status', 'Done').orderBy('t.id')
      .select('t.id', 't.title', 't.assignee_id', 'p.name as project_name'),
  ]);
  const PPL = Object.fromEntries(ppl.map((p) => [p.id, p]));
  const byP = groupAttendance(evs, T, addDays(T, 1));
  const TM = Object.fromEntries(tms.map((t) => [t.person_id, t]));
  const logT = {};
  logs.forEach((l) => { logT[l.member_id] = (logT[l.member_id] || 0) + Number(l.hours); });

  const liveAll = ppl.map((p) => {
    const list = byP[`${p.id}|${T}`] || [];
    const s = sumDay(list, T, now);
    const has = list.length > 0;
    const tm = TM[p.id];
    const idl = pres[p.id];
    let status;
    let hue;
    let key;
    if (!has) { status = pastLate ? 'Not checked in' : 'Not in yet'; hue = pastLate ? 25 : 265; key = pastLate ? 'absent' : 'off'; } else if (!s.online && !s.onBreak) { status = s.last ? `Checked out ${clock(s.last)}` : 'Checked out'; hue = 265; key = 'off'; } else if (s.onBreak) { status = `On break · ${fmtDur(now - s.breaks.at(-1)[0])}`; hue = 70; key = 'break'; } else if (idl && now - idl >= 30 * MINUTE) { status = `Idle ${fmtDur(now - idl)}`; hue = 25; key = 'idle'; } else if (p.sales || tm) { status = 'Working'; hue = 150; key = 'work'; } else { status = 'No timer running'; hue = 70; key = 'notimer'; }

    const run = tm ? now - new Date(tm.started_at).getTime() : 0;
    const todayH = (logT[p.id] || 0) + run / HOUR;
    const myActs = acts.filter((x) => x.owner === p.id).sort((x, y) => y.t - x.t);
    const late = isLate(s.first, T);
    const checkedIn = s.online || s.onBreak;
    return {
      id: p.id, key, sales: p.sales, name: p.name, role: p.role, team: p.team, hue: p.hue, status, statusHue: hue,
      todayH, today: h1(todayH), shift: p.shift,
      doing: tm ? tm.title : p.sales ? (myActs[0] ? myActs[0].text : 'No lead activity yet today') : '—',
      doingSub: tm
        ? `${tm.project_name ? `${tm.project_name} · ` : ''}timer running ${fmtDur(run)}`
        : p.sales ? `${myActs.length} lead action${myActs.length === 1 ? '' : 's'} today${myActs[0] ? ` · last at ${clock(myActs[0].t)}` : ''}` : '',
      checkInAt: iso(s.first), inLabel: has ? clock(s.first) + (late ? ' · late' : '') : '—', late,
      checkedIn: has, canIn: !checkedIn, canOut: checkedIn, canBreak: checkedIn, brkLabel: s.onBreak ? 'Resume' : 'Break',
      timer: tm ? { taskId: tm.task_id, projectId: tm.project_id, title: tm.title, startedAt: iso(tm.started_at) } : null,
      hasTimer: !!tm, canStart: !p.sales && s.online && !tm,
      tasks: p.sales ? [] : openTasks.filter((t) => t.assignee_id === p.id).slice(0, 15).map((t) => ({ value: t.id, label: `${t.title} · ${t.project_name}` })),
    };
  }).sort((a, b) => ORD[a.key] - ORD[b.key] || a.name.localeCompare(b.name));

  const cnt = (k) => liveAll.filter((x) => x.key === k).length;
  const names = (list) => list.map((x) => x.name).join(', ');
  const delH = liveAll.filter((x) => !x.sales).reduce((s, x) => s + x.todayH, 0);
  const touched = new Set(acts.map((x) => x.leadId)).size;

  // Alerts (project-health / CR-over-estimate / hot-lead alerts are left to the projects & leads modules)
  const alerts = [];
  const push = (a) => alerts.push({ key: `a${alerts.length}`, ...a });
  if (cnt('absent')) push({ hue: 25, title: `${cnt('absent')} not checked in by 10:30`, sub: names(liveAll.filter((x) => x.key === 'absent')), actLabel: 'Show', action: { type: 'liveF', value: 'absent' } });
  if (cnt('idle')) push({ hue: 25, title: `${cnt('idle')} idle for 30+ minutes`, sub: names(liveAll.filter((x) => x.key === 'idle')), actLabel: 'Show', action: { type: 'liveF', value: 'idle' } });
  if (cnt('notimer')) push({ hue: 70, title: `${cnt('notimer')} checked in with no timer running`, sub: names(liveAll.filter((x) => x.key === 'notimer')), actLabel: 'Show', action: { type: 'liveF', value: 'attention' } });
  for (const m of await repo.changesRequested(db)) {
    push({ hue: 25, title: `${m.client || 'Client'} requested changes · ${m.name}`, sub: `${m.approval_note || ''} · ${m.project_name || ''}`, actLabel: 'Open project', action: { type: 'project', pid: m.project_id } });
  }
  const waiting = (await repo.crsAwaiting(db)).filter((c) => now - new Date(c.sent_at || c.raised_at).getTime() > 3 * DAY).slice(0, 3);
  for (const c of waiting) {
    const days = Math.floor((now - new Date(c.sent_at || c.raised_at).getTime()) / DAY);
    push({
      hue: 70, title: `${c.id} waiting ${days} days for ${c.client || 'client'} approval`, sub: `${c.title} · ${Number(c.hours)}h · ₹${Number(c.amount).toLocaleString('en-IN')}`,
      actLabel: 'Open project', action: { type: 'project', pid: c.project_id },
    });
  }
  const yd = T - DAY;
  if (!isSunday(yd)) {
    const miss = await repo.missingTimesheets(db, ymd(yd));
    if (miss.length) push({ hue: 70, title: `${miss.length} timesheet${miss.length > 1 ? 's' : ''} missing for yesterday`, sub: miss.map((x) => x.name).join(', '), actLabel: 'Open timesheets', action: { type: 'timesheets' } });
  }

  const kpis = [
    ['work', 'Working now', cnt('work'), 150, `${liveAll.length} people`],
    ['break', 'On break', cnt('break'), 70, ''],
    ['idle', 'Idle 30m+', cnt('idle'), 25, ''],
    ['absent', pastLate ? 'Not checked in' : 'Not in yet', pastLate ? cnt('absent') : liveAll.filter((x) => !x.checkedIn).length, 25, pastLate ? 'after 10:30' : 'before 10:30'],
    ['delivery', 'Delivery hours today', h1(delH), 265, 'logged + running timers'],
    ['sales', 'Leads touched today', touched, 150, `${acts.length} actions`],
  ].map(([key, label, value, hue, sub]) => ({ key, label, value, sub, hue }));

  const chips = LIVE_CHIPS.map(([key, label]) => ({ key, label, count: liveAll.filter(LIVE_FILTERS[key]).length }));
  const people = liveAll.filter(LIVE_FILTERS[filter] || LIVE_FILTERS.all);

  // Feed: team lines, sales lead actions, client approvals
  const grp = feedF === 'clients' ? 'proj' : feedF;
  const feed = teamFeed.map((e) => ({ t: new Date(e.at).getTime(), who: e.person_id, grp: 'team', text: e.text, kind: e.kind }))
    .concat(acts.map((x) => ({ t: x.t, who: x.owner, grp: 'sales', text: x.fromFeed ? x.text : `${x.text} · ${x.company}`, kind: x.kind })))
    .concat(approvals.map((m) => ({ t: new Date(m.approval_at).getTime(), who: null, grp: 'proj', text: `${m.client || 'Client'} · ${m.approval_status.toLowerCase()} · ${m.name}`, kind: 'appr' })))
    .filter((e) => grp === 'all' || e.grp === grp)
    .sort((a, b) => b.t - a.t)
    .slice(0, 200)
    .map((e) => {
      const p = PPL[e.who];
      return { at: iso(e.t), time: clock(e.t), personId: e.who, who: p ? p.name : 'Client', hue: p ? p.hue : 150, group: e.grp === 'proj' ? 'clients' : e.grp, kind: e.kind, kindHue: FK[e.kind] ?? 265, text: e.text };
    });

  // Sales table
  const owners = ppl.filter((p) => p.sales);
  const fus = await repo.followUpsFor(db, owners.map((o) => o.id));
  const due = (f) => new Date(f.due_at).getTime();
  const sales = owners.map((o) => {
    const r = liveAll.find((x) => x.id === o.id);
    const ac = acts.filter((x) => x.owner === o.id);
    const fT = fus.filter((f) => f.owner_id === o.id && due(f) >= T && due(f) < addDays(T, 1));
    return {
      id: o.id, name: o.name, hue: o.hue, status: r.status, statusHue: r.statusHue, key: r.key,
      touched: new Set(ac.map((x) => x.leadId)).size,
      calls: ac.filter((x) => x.kind === 'call').length,
      quotes: ac.filter((x) => x.kind === 'quote' && /^Sent/.test(x.text)).length,
      fu: `${fT.filter((f) => f.done).length} / ${fT.length}`,
      overdue: fus.filter((f) => f.owner_id === o.id && !f.done && due(f) < now).length,
    };
  });

  const summary = `Mariox · ${fmtDate(now, { weekday: 'short', day: 'numeric', month: 'short' })} · ${clock(now)}\n`
    + `${cnt('work')} working · ${cnt('break')} on break · ${cnt('idle')} idle · ${cnt('absent')} not checked in\n`
    + `Delivery hours today: ${h1(delH)}\nLeads touched today: ${touched}\n`
    + (alerts.length ? `\nNeeds attention:\n${alerts.map((a) => `• ${a.title}`).join('\n')}` : '\nNothing needs attention.');

  return {
    now: iso(now), day: ymd(T),
    sub: `Updated ${clock(now)} · refreshes every 20 seconds · ${liveAll.filter((x) => x.checkedIn).length} of ${liveAll.length} checked in today`,
    kpis, alerts, chips, people, feed, sales, summary,
  };
}

/** CEO acting on someone from the Live page. */
export async function liveAction(pid, action, body = {}) {
  const ok = (await repo.member(db, pid)) || (await repo.salesOwner(db, pid));
  if (!ok) throw notFound('Person');
  switch (action) {
    case 'check-in': return wd.checkIn(pid);
    case 'check-out': return wd.checkOut(pid);
    case 'break': return wd.startBreak(pid, body.type || null, body.note || '');
    case 'resume': return wd.endBreak(pid);
    case 'timer/start': return wd.startTimer(pid, body.taskId);
    case 'timer/stop': return wd.stopTimer(pid);
    default: throw notFound('Action');
  }
}

/* ───────────── Attendance ───────────── */

const HOUR_8 = 8 * HOUR;
const SPAN = 14 * HOUR;
const pc = (t, d) => Math.max(0, Math.min(100, ((t - d - HOUR_8) / SPAN) * 100));

async function loadRange(rng, T, pplFilter = () => true) {
  const ppl = (await repo.people(db)).filter(pplFilter);
  const ids = ppl.map((p) => p.id);
  const [evs, reps, projects] = await Promise.all([
    repo.events(db, ids, rng[0], rng[1]),
    repo.reportsIn(db, ids, ymd(rng[0]), ymd(Math.min(rng[1], addDays(T, 1)))),
    repo.projects(db),
  ]);
  const PRJ = Object.fromEntries(projects.map((p) => [p.id, p]));
  const REP = Object.fromEntries(reps.map((r) => [`${r.person_id}|${r.day}`, r]));
  return { ppl, byPD: groupAttendance(evs, rng[0], rng[1]), REP, projectName: (id) => (PRJ[id] || {}).name };
}

function dayRow(p, d, label, sub, ctx) {
  const { byPD, T, now, REP, projectName } = ctx;
  const list = byPD[`${p.id}|${d}`] || [];
  const s = sumDay(list, d, now);
  const late = isLate(s.first, d);
  const st = !list.length
    ? (d === T && now < d + LATE_MS ? ['Not in yet', 265] : ['Absent', 25])
    : s.onBreak ? ['On break', 70] : s.online ? ['Online', 150] : ['Logged out', 265];
  return {
    key: `${p.id}|${ymd(d)}`, personId: p.id, name: p.name, role: p.role, team: p.team, hue: p.hue, day: ymd(d), label, sub,
    status: st[0], statusHue: st[1], present: list.length > 0, late,
    in: iso(s.first), out: iso(s.last), inL: s.first ? clock(s.first) : '—', outL: s.last ? clock(s.last) : s.online || s.onBreak ? 'Still in' : '—',
    breaks: s.breaks.map(([a, b]) => ({ from: iso(a), to: iso(b) })),
    brkL: s.breaks.length ? `${s.breaks.length} · ${fmtDur(s.br)}` : '—',
    brkTimes: s.breaks.map((b) => `${clock(b[0])}–${b[1] ? clock(b[1]) : 'now'}`).join(', '),
    breakMs: s.br, workMs: s.work, worked: list.length ? fmtDur(s.work) : '—', workedFlag: workedFlag(s.work, d, T, list.length > 0),
    segs: s.segs.map((g) => ({
      kind: g[0] === 'w' ? 'work' : 'break', from: iso(g[1]), to: iso(g[2]),
      left: `${pc(g[1], d).toFixed(2)}%`, width: `${Math.max(0.5, pc(g[2], d) - pc(g[1], d)).toFixed(2)}%`,
      tip: `${g[0] === 'w' ? 'Working ' : 'Break '}${clock(g[1])}–${clock(g[2])}`,
    })),
    report: reportLines(REP[`${p.id}|${ymd(d)}`], projectName),
    events: list.map((e) => ({ at: iso(e.t), time: clock(e.t), kind: e.k, text: EVL[e.k][0], hue: EVL[e.k][1] })),
  };
}

const dayShort = (d) => fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
const dayLong = (d) => fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });

export async function attendance(AF) {
  const now = Date.now();
  const T = sod(now);
  const { isDay, day: dSel, rng } = resolveRange(AF, T);
  const aDays = workdays(rng, T);
  const aq = (AF.q || '').trim().toLowerCase();
  const all = await loadRange(rng, T);
  const aPpl = all.ppl.filter((p) => (!AF.team || p.team === AF.team) && (!aq || p.name.toLowerCase().includes(aq)));
  const ctx = { ...all, T, now };
  const selP = (AF.person && all.ppl.find((p) => p.id === AF.person)) || null;
  if (AF.person && !selP) throw notFound('Person');

  let rows = [];
  let sum = [];
  let kpis;
  if (selP) {
    rows = aDays.slice().reverse().map((d) => dayRow(selP, d, dayShort(d), d === T ? 'Today' : '', ctx));
  } else if (isDay) {
    rows = aPpl.map((p) => dayRow(p, dSel, p.name, p.role, ctx)).sort((a, b) => (b.present - a.present) || (a.inL > b.inL ? 1 : -1));
  } else {
    sum = aPpl.map((p) => {
      let wk = 0; let br = 0; let pres = 0; let late = 0;
      const ins = []; const outs = [];
      aDays.forEach((d) => {
        const list = all.byPD[`${p.id}|${d}`];
        if (!list) return;
        const s = sumDay(list, d, now);
        pres++; wk += s.work; br += s.br;
        if (isLate(s.first, d)) late++;
        if (s.first) ins.push(s.first - d);
        if (s.last) outs.push(s.last - d);
      });
      const avgT = (a) => (a.length ? clock(T + a.reduce((x, y) => x + y, 0) / a.length) : '—');
      const expected = aDays.filter((d) => isExpectedDay(d, T, now)).length;
      return {
        personId: p.id, name: p.name, role: p.role, team: p.team, hue: p.hue,
        present: `${pres} / ${expected}`, presentDays: pres, expectedDays: expected, absent: Math.max(0, expected - pres), late,
        avgIn: avgT(ins), avgOut: avgT(outs), total: fmtDur(wk), totalMs: wk, brk: fmtDur(br), breakMs: br, avg: pres ? fmtDur(wk / pres) : '—',
      };
    }).sort((a, b) => b.totalMs - a.totalMs);
  }

  if (selP || isDay) {
    const pr = rows.filter((r) => r.present);
    const tw = pr.reduce((x, r) => x + r.workMs, 0);
    kpis = selP
      ? [
        ['Days present', `${pr.length} / ${rows.filter((r) => r.status !== 'Not in yet').length}`, ''],
        ['Late days', rows.filter((r) => r.late).length, 'after 10:30'],
        ['Total worked', fmtDur(tw), ''],
        ['Average per day', pr.length ? fmtDur(tw / pr.length) : '—', ''],
      ]
      : [
        ['Present', `${pr.length} / ${rows.length}`, ''],
        ['Online now', rows.filter((r) => r.status === 'Online').length, dSel === T ? 'working' : '—'],
        ['On break', rows.filter((r) => r.status === 'On break').length, ''],
        ['Late', rows.filter((r) => r.late).length, 'after 10:30'],
        ['Absent', rows.filter((r) => r.status === 'Absent').length, ''],
        ['Total worked', fmtDur(tw), pr.length ? `avg ${fmtDur(tw / pr.length)}` : ''],
      ];
  } else {
    const tw = sum.reduce((x, r) => x + r.totalMs, 0);
    kpis = [
      ['Total worked', fmtDur(tw), `${aDays.length} working days`],
      ['Late arrivals', sum.reduce((x, r) => x + r.late, 0), 'after 10:30'],
      ['Absences', sum.reduce((x, r) => x + r.absent, 0), 'person-days'],
      ['Average per person', sum.length ? fmtDur(tw / sum.length) : '—', ''],
    ];
  }

  return {
    view: selP ? 'person' : isDay ? 'day' : 'summary',
    from: ymd(rng[0]), to: ymd(rng[1] - 1),
    title: selP ? selP.name : isDay ? dayLong(dSel) : RANGE_TITLES[AF.range] || '',
    person: selP && { id: selP.id, name: selP.name, role: selP.role, team: selP.team },
    kpis: kpis.map(([label, value, sub]) => ({ label, value, sub })),
    rows, summary: sum, empty: rows.length + sum.length === 0,
  };
}

/** CSV rows: one line per person per working day in range. */
export async function attendanceCsv(AF) {
  const now = Date.now();
  const T = sod(now);
  const { rng } = resolveRange(AF, T);
  const aDays = workdays(rng, T);
  const aq = (AF.q || '').trim().toLowerCase();
  const all = await loadRange(rng, T);
  const aPpl = all.ppl.filter((p) => (!AF.person || p.id === AF.person) && (!AF.team || p.team === AF.team) && (!aq || p.name.toLowerCase().includes(aq)));
  const out = [['Date', 'Person', 'Team', 'Logged in', 'Logged out', 'Breaks', 'Break time (min)', 'Worked (h)', 'Late']];
  aPpl.forEach((p) => aDays.forEach((d) => {
    const list = all.byPD[`${p.id}|${d}`];
    const s = list ? sumDay(list, d, now) : null;
    out.push([
      ymd(d), p.name, p.team,
      s && s.first ? clock(s.first) : 'Absent',
      s && s.last ? clock(s.last) : s ? 'Still in' : '',
      s ? s.breaks.length : 0,
      s ? Math.round(s.br / 6e4) : 0,
      s ? (s.work / HOUR).toFixed(2) : 0,
      s && isLate(s.first, d) ? 'Yes' : '',
    ]);
  }));
  return { rows: out, name: `mariox-attendance-${ymd(rng[0])}.csv` };
}

/* ───────────── Reports ───────────── */

const H0 = 6 * HOUR;
const HS = 18 * HOUR;
const HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22];
const hLbl = (h) => `${h % 12 || 12}${h < 12 || h === 24 ? 'am' : 'pm'}`;
const agoLong = (t, now) => {
  const m = Math.round((now - t) / MINUTE);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)} day${m >= 2880 ? 's' : ''} ago`;
};

export async function timeline({ mode = 'day', day, team }) {
  const now = Date.now();
  const T = sod(now);
  const tD = day ? parseDay(day) : T;
  const wk = mode === 'week';
  const tStart = wk ? addDays(tD, -((weekday(tD) + 6) % 7)) : tD;
  const tDays = wk ? [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(tStart, i)) : [tD];
  const tEnd = addDays(tDays.at(-1), 1);
  const nD = tDays.length;
  const ppl = (await repo.people(db)).filter((p) => !team || p.team === team);
  const [evs, lastBy] = await Promise.all([repo.events(db, ppl.map((p) => p.id), tStart, tEnd), repo.lastTracked(db)]);
  const tBy = groupAttendance(evs, tStart, tEnd);
  const xp = (t, i, d) => ((i + Math.max(0, Math.min(1, (t - d - H0) / HS))) / nD) * 100;

  const rows = ppl.map((p) => {
    let tot = 0;
    let live = null;
    const segs = [];
    const dayTotals = [];
    tDays.forEach((d, i) => {
      const list = tBy[`${p.id}|${d}`];
      if (!list) return;
      const s = sumDay(list, d, now);
      tot += s.work;
      if (d === T) live = s;
      s.segs.forEach((g) => {
        const l = xp(g[1], i, d);
        const r = xp(g[2], i, d);
        if (r - l <= 0) return;
        const isW = g[0] === 'w';
        segs.push({
          day: ymd(d), kind: isW ? 'work' : 'break', from: iso(g[1]), to: iso(g[2]),
          left: `${l.toFixed(3)}%`, width: `${Math.max(0.25, r - l).toFixed(3)}%`,
          tip: `${isW ? 'Working' : 'Break'} · ${clock(g[1])} – ${g[2] >= now - MINUTE && d === T ? 'now' : clock(g[2])} · ${fmtDur(g[2] - g[1])}`,
        });
      });
      if (wk) dayTotals.push({ day: ymd(d), left: `${(i / nD) * 100}%`, width: `${100 / nD}%`, text: fmtDur(s.work) });
    });
    const on = live && live.online;
    const br = live && live.onBreak;
    const lt = lastBy[p.id];
    return {
      personId: p.id, name: p.name, role: p.role, team: p.team, hue: p.hue,
      total: tot ? fmtDur(tot) : '—', totalMs: tot, segs, dayTotals, state: on ? 'work' : br ? 'break' : 'off', rank: on ? 0 : br ? 1 : 2,
      sub: on ? `Working now · ${p.role || ''}` : br ? `On break · ${p.role || ''}` : lt ? `Last tracked: ${agoLong(lt, now)}` : 'Never tracked',
    };
  }).sort((a, b) => a.rank - b.rank || b.totalMs - a.totalMs);

  const step = wk ? 7 : 1;
  const nextDay = addDays(tD, step);
  return {
    mode: wk ? 'week' : 'day', day: ymd(tD),
    label: wk
      ? `${fmtDate(tStart, { day: 'numeric', month: 'short' })} – ${fmtDate(tDays[6], { day: 'numeric', month: 'short', year: 'numeric' })}`
      : fmtDate(tD, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    cols: wk
      ? tDays.map((d, i) => ({ key: ymd(d), label: fmtDate(d, { weekday: 'short', day: 'numeric' }), left: `${(i / nD) * 100}%`, width: `${100 / nD}%` }))
      : HOURS.map((h) => ({ key: String(h), label: hLbl(h), left: `${((h - 6) / 18) * 100}%`, width: `${(2 / 18) * 100}%` })),
    rows,
    prevDay: ymd(addDays(tD, -step)), nextDay: ymd(nextDay), canNext: nextDay <= T,
  };
}

async function hoursLogData(RF) {
  const now = Date.now();
  const T = sod(now);
  const { isDay, day: rSel, rng } = resolveRange(RF, T);
  const rDays = workdays(rng, T).reverse();
  const allPpl = await repo.people(db);
  const rP = RF.person ? allPpl.find((p) => p.id === RF.person) : null;
  if (RF.person && !rP) throw notFound('Person');
  const rPpl = rP ? [rP] : allPpl;
  const rBy = groupAttendance(await repo.events(db, rPpl.map((p) => p.id), rng[0], rng[1]), rng[0], rng[1]);
  let tw = 0; let tb = 0; let pres = 0; let late = 0;
  const csv = [];
  const days = rDays.map((d) => {
    const rows = [];
    rPpl.forEach((p) => {
      const list = rBy[`${p.id}|${d}`];
      if (!list) {
        if (rP && isExpectedDay(d, T, now)) rows.push({ personId: p.id, name: p.name, hue: p.hue, absent: true, events: [], brk: '—', worked: '—', workMs: 0, workedFlag: '' });
        return;
      }
      const s = sumDay(list, d, now);
      tw += s.work; tb += s.br; pres++;
      if (isLate(s.first, d)) late++;
      const events = narrateDay(list, s, d, now, 'log');
      events.forEach((ev) => { if (!ev.now) csv.push([ymd(d), p.name, ev.raw, ev.time, ev.sub]); });
      rows.push({
        personId: p.id, name: p.name, hue: p.hue, absent: false, events,
        brk: s.breaks.length ? `${s.breaks.length} · ${fmtDur(s.br)}` : 'None', worked: fmtDur(s.work), workMs: s.work, workedFlag: workedFlag(s.work, d, T),
      });
    });
    return {
      day: ymd(d), label: fmtDate(d, { weekday: 'long', day: 'numeric', month: 'short' }) + (d === T ? ' · Today' : ''),
      sub: `${rows.filter((r) => !r.absent).length} present`, rows,
    };
  }).filter((x) => x.rows.length);
  const fmt = (t, o) => fmtDate(t, o);
  return {
    T, rng,
    days,
    title: `${rP ? rP.name : 'Everyone'} · ${isDay
      ? fmt(rSel, { day: 'numeric', month: 'short', year: 'numeric' })
      : `${fmt(rng[0], { day: 'numeric', month: 'short' })} – ${fmt(Math.min(rng[1], addDays(T, 1)) - 1, { day: 'numeric', month: 'short' })}`}`,
    kpis: [
      ['Total worked', fmtDur(tw), pres ? `avg ${fmtDur(tw / pres)} per day` : ''],
      ['Break time', fmtDur(tb), ''],
      ['Days present', pres, rP ? `of ${rDays.filter((d) => isExpectedDay(d, T, now)).length}` : 'person-days'],
      ['Late logins', late, 'after 10:30'],
    ].map(([label, value, sub]) => ({ label, value, sub })),
    people: allPpl.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name })),
    csv: [['Date', 'Person', 'Event', 'Time', 'Note']].concat(csv),
  };
}

export async function hoursLog(RF) {
  const { days, title, kpis, people } = await hoursLogData(RF);
  return { title, kpis, days, people };
}

export async function hoursLogCsv(RF) {
  const { csv, T } = await hoursLogData(RF);
  return { rows: csv, name: `mariox-hours-${ymd(T)}.csv` };
}

/** RFC 4180 CSV; cells that look like formulas are prefixed with ' (CSV injection guard). */
export function toCsv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
