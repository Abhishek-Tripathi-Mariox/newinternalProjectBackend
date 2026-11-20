/**
 * GET /founder/summary — the Mariox summary the cofounder portal reads (CofounderMariox README →
 * "Summary API"). Read-only, everyone's data (no user scope): it is guarded by FOUNDER_API_KEY.
 *
 * Periods are in the business time zone (APP_TZ): today, this week (from Monday) and this month,
 * each "to date". `prev` is the same span of the previous week / month, so a Wednesday is compared
 * with last Monday–Wednesday rather than with a whole week.
 * Money in rupees; dates ISO 8601 (calendar days as the start of that day in APP_TZ).
 * Not tracked by the internal portal: client payments, so `cash` is null.
 * Also: end-of-shift reports + blockers, quotes waiting on clients, projects on hold, team tasks.
 */
import { db } from '../../db/knex.js';
import * as workday from '../workday/workday.repository.js';
import { liveState } from '../workday/state.service.js';
import { groupAttendance, sumDay, isLate } from '../workday/attendance.domain.js';
import { DAY, MINUTE, sod, addDays, weekday, isSunday, monthStart, parseDay, ymd, iso } from '../workday/time.js';

const OPEN_BUG = ['Open', 'In progress', 'Retest', 'Reopened'];
const WEEKS = 12;
/** Past days of attendance sent with the summary (enough for yesterday and the whole current week). */
const HISTORY_DAYS = 7;

const num = (v) => Number(v) || 0;
const ms = (v) => (v == null ? null : new Date(v).getTime());
/** 'YYYY-MM-DD' (or a Date) → ISO instant of that day's start in APP_TZ. */
const dayIso = (d) => (d ? iso(parseDay(typeof d === 'string' ? d.slice(0, 10) : ymd(new Date(d).getTime()))) : null);
const none = (ids) => (ids.length ? ids : ['__none__']);

/** Period bounds (epoch ms) for `now`. */
export function periods(now) {
  const T = sod(now);
  const weekStart = addDays(T, -((weekday(T) + 6) % 7));
  const monthStartT = monthStart(T);
  const prevMonth = monthStart(T, -1);
  return {
    T,
    weekStart,
    monthStart: monthStartT,
    today: { from: T, to: now },
    week: { from: weekStart, to: now, prevFrom: addDays(weekStart, -7), prevTo: addDays(weekStart, -7) + (now - weekStart) },
    month: { from: monthStartT, to: now, prevFrom: prevMonth, prevTo: Math.min(prevMonth + (now - monthStartT), monthStartT) },
  };
}

/** Won / lost leads with the time they closed: the last "Stage: … → Won|Lost" activity, else updated_at. */
async function closedLeads() {
  const { rows } = await db.raw(`
    select l.id, l.status, l.value, l.owner_id, coalesce(c.at, l.updated_at) as closed_at
    from leads l
    left join lateral (
      select max(a.at) as at from lead_activities a
      where a.lead_id = l.id and a.kind = 'status' and a.text like ('%→ ' || l.status)
    ) c on true
    where l.status in ('Won', 'Lost')`);
  return rows.map((r) => ({ id: r.id, status: r.status, value: num(r.value), owner: r.owner_id, at: ms(r.closed_at) }));
}

const within = (rows, from, to) => rows.filter((r) => r.at >= from && r.at < to);
const total = (rows) => ({ value: rows.reduce((a, r) => a + r.value, 0), deals: rows.length });

function wonBlock(won, p) {
  const cur = total(within(won, p.from, p.to));
  if (p.prevFrom == null) return cur;
  return { ...cur, prev: total(within(won, p.prevFrom, p.prevTo)).value };
}

/** Current milestone (first not Done), budget use and the pending client approval for one project. */
function projectRow(p, milestones, logged) {
  const cur = milestones.find((m) => m.status !== 'Done');
  const budget = p.budget_hours != null ? num(p.budget_hours) : milestones.reduce((a, m) => a + num(m.alloc_hours), 0);
  const projectDue = p.expected_delivery_date || p.due_date;
  const last = milestones.at(-1);
  return {
    id: p.id,
    name: p.name,
    client: p.client,
    pm: p.pm_name || '—',
    milestone: cur
      ? { n: cur.n, name: cur.name, due: dayIso(cur.due_date || projectDue) }
      : { n: last ? last.n : null, name: last ? 'All milestones done' : 'No milestones yet', due: dayIso(projectDue) },
    hoursUsed: budget > 0 ? Math.round((logged / budget) * 100) / 100 : null,
    hoursLogged: Math.round(logged * 100) / 100,
    hoursBudget: budget > 0 ? budget : null,
    approvalAskedAt: cur && cur.approval_status === 'Pending' && cur.approval_asked_at ? iso(ms(cur.approval_asked_at)) : null,
    note: p.status_note || '',
  };
}

function personRow(p, live, T) {
  const a = live.att[p.id];
  const t = live.timers[p.id];
  return {
    id: p.id,
    name: p.name,
    hue: p.hue,
    team: p.team,
    checkInAt: a && a.in ? a.in : null,
    checkOutAt: a && a.out ? a.out : null,
    late: isLate(a && a.in ? ms(a.in) : null, T),
    break: a && a.brk ? { kind: a.brkType || 'Break', startedAt: a.brk, plannedMin: a.brkPlan || null } : null,
    timer: t ? { task: t.title, projectId: t.p, startedAt: t.start } : null,
    activity: null,
  };
}

/**
 * Extra founder numbers (added after the first version of the summary):
 *  reports    today's end-of-shift reports and the blockers people wrote (today + yesterday)
 *  quotes     proposals waiting on the client (Sent / Viewed) and accepted this month
 *  onHold     projects on hold, with the reason the PM gave
 *  teamTasks  tasks assigned to the team (Team tasks): open, overdue, done this week
 */
async function extras(P, now, people, live) {
  const T = P.T;
  const yesterday = ymd(addDays(T, -1));
  const [reports, quotes, held, tasks] = await Promise.all([
    db('shift_reports').where('day', '>=', yesterday).select('person_id', 'day', 'blockers', 'submitted_at'),
    db('quotes as q').join('leads as l', 'l.id', 'q.lead_id').whereIn('q.status', ['Sent', 'Viewed', 'Accepted'])
      .select('q.id', 'q.status', 'q.net', 'q.total', 'q.sent_at', 'q.accepted_at', 'l.company'),
    db('projects as p').leftJoin('members as m', 'm.id', 'p.pm_member_id').where('p.status', 'On hold').orderBy('p.status_note_at', 'desc')
      .select('p.id', 'p.name', 'p.client', 'p.status_reason', 'p.status_note', 'p.status_note_at', 'p.updated_at', 'm.name as pm_name'),
    db('team_tasks as t').join('users as u', 'u.id', 't.assignee_id')
      .select('t.id', 't.title', 't.status', 't.priority', 't.due_date', 't.done_at', 'u.name as assignee'),
  ]);

  const nameOf = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const today = ymd(T);
  const dayOf = (d) => (typeof d === 'string' ? d.slice(0, 10) : ymd(new Date(d).getTime()));
  const todays = reports.filter((r) => dayOf(r.day) === today);
  const blockers = reports
    .filter((r) => (r.blockers || '').trim())
    .sort((a, b) => ms(b.submitted_at) - ms(a.submitted_at))
    .map((r) => ({ who: r.person_id, name: nameOf[r.person_id] || r.person_id, text: r.blockers.trim(), day: dayIso(dayOf(r.day)), at: iso(ms(r.submitted_at)) }));

  const amount = (q) => num(q.net) || num(q.total);
  const waiting = quotes.filter((q) => q.status === 'Sent' || q.status === 'Viewed');
  const accepted = quotes.filter((q) => q.status === 'Accepted' && ms(q.accepted_at) >= P.month.from);
  const oldest = waiting.reduce((m, q) => (q.sent_at && (m == null || ms(q.sent_at) < m) ? ms(q.sent_at) : m), null);

  const open = tasks.filter((t) => t.status !== 'Done');
  const overdue = open.filter((t) => t.due_date && dayOf(t.due_date) < today).sort((a, b) => (dayOf(a.due_date) < dayOf(b.due_date) ? -1 : 1));

  return {
    reports: { checkedIn: Object.keys(live.att).length, submitted: todays.length, blockers: blockers.slice(0, 10) },
    quotes: {
      waiting: { count: waiting.length, value: waiting.reduce((a, q) => a + amount(q), 0), oldestSentAt: iso(oldest) },
      acceptedMonth: { count: accepted.length, value: accepted.reduce((a, q) => a + amount(q), 0) },
    },
    onHold: held.map((p) => ({
      id: p.id, name: p.name, client: p.client, pm: p.pm_name || '—', reason: p.status_reason || '', note: p.status_note || '',
      since: iso(ms(p.status_note_at || p.updated_at)),
    })),
    teamTasks: {
      open: open.length,
      overdue: overdue.length,
      doneWeek: tasks.filter((t) => t.done_at && ms(t.done_at) >= P.weekStart).length,
      overdueList: overdue.slice(0, 5).map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, priority: t.priority, due: dayIso(dayOf(t.due_date)) })),
    },
  };
}

/**
 * Attendance for the past HISTORY_DAYS working days (Sundays skipped), newest first. Each day lists
 * only the people who checked in. A day without a logout keeps checkOutAt null and counts work up
 * to the last break / logout event only.
 */
async function attendanceHistory(T, now) {
  const from = addDays(T, -HISTORY_DAYS);
  const byPersonDay = groupAttendance(await workday.events(db, null, from, T), from, T);
  const days = [];
  for (let i = 1; i <= HISTORY_DAYS; i++) {
    const day = addDays(T, -i);
    if (isSunday(day)) continue;
    const people = [];
    for (const [key, list] of Object.entries(byPersonDay)) {
      const [who, dayKey] = key.split('|');
      if (Number(dayKey) !== day) continue;
      const s = sumDay(list, day, now);
      if (s.first == null) continue;
      people.push({
        id: who,
        checkInAt: iso(s.first),
        checkOutAt: iso(s.last),
        late: isLate(s.first, day),
        workedMin: Math.round(s.work / MINUTE),
        breakMin: Math.round(s.br / MINUTE),
        breaks: s.breaks.length,
      });
    }
    days.push({ day: iso(day), people });
  }
  return days;
}

const STATE_ORDER = { in: 0, break: 1, left: 2, out: 3 };
const stateOf = (x) => (!x.checkInAt ? 'out' : x.break ? 'break' : x.checkOutAt ? 'left' : 'in');

export async function marioxSummary(now = Date.now()) {
  const P = periods(now);

  const [closed, openLeads, newToday, newWeek, stageNames, owners, openFus, crs, bugsOpen, critical, projects, people, live, logsToday, history] = await Promise.all([
    closedLeads(),
    db('leads').whereNotIn('status', ['Won', 'Lost']).select('status', 'owner_id', 'value'),
    db('leads').where('created_at', '>=', new Date(P.T)).count('* as n').first(),
    db('leads').where('created_at', '>=', new Date(P.weekStart)).count('* as n').first(),
    db('lead_stages').whereNotIn('name', ['Won', 'Lost']).orderBy('position').pluck('name'),
    db('sales_owners').where({ active: true }).orderBy('name').select('id', 'name', 'hue'),
    db('follow_ups').where({ done: false }).select('owner_id', 'due_at'),
    db('change_requests').where({ status: 'Sent to client' }).count('* as n').sum('amount as v').first(),
    db('bugs').whereIn('status', OPEN_BUG).count('* as n').first(),
    db('bugs as b').join('projects as p', 'p.id', 'b.project_id').whereIn('b.status', OPEN_BUG).where('b.severity', 'Critical')
      .orderBy('b.reported_on').select('b.id', 'b.project_id', 'p.name as project_name', 'b.reported_on'),
    db('projects as p').leftJoin('members as m', 'm.id', 'p.pm_member_id').where('p.status', 'Running').orderBy('p.id')
      .select('p.id', 'p.name', 'p.client', 'p.due_date', 'p.expected_delivery_date', 'p.budget_hours', 'p.status_note', 'm.name as pm_name'),
    workday.people(),
    liveState(null, now),
    db('time_logs').where('day', ymd(P.T)).sum('hours as h').first(),
    attendanceHistory(P.T, now),
  ]);

  const ids = projects.map((p) => p.id);
  const [milestones, logged] = await Promise.all([
    db('milestones').whereIn('project_id', none(ids)).orderBy([{ column: 'project_id' }, { column: 'n' }])
      .select('project_id', 'n', 'name', 'due_date', 'status', 'alloc_hours', 'approval_status', 'approval_asked_at'),
    db('time_logs').whereIn('project_id', none(ids)).groupBy('project_id').select('project_id').sum('hours as h'),
  ]);
  const msBy = {};
  for (const m of milestones) (msBy[m.project_id] = msBy[m.project_id] || []).push(m);
  const loggedBy = Object.fromEntries(logged.map((r) => [r.project_id, num(r.h)]));

  // Sales
  const won = closed.filter((l) => l.status === 'Won');
  const lost = closed.filter((l) => l.status === 'Lost');
  const open = openLeads.map((l) => ({ status: l.status, owner: l.owner_id, value: num(l.value) }));
  const quarter = closed.filter((l) => l.at >= now - 90 * DAY && l.at < now);
  const qWon = quarter.filter((l) => l.status === 'Won').length;

  const stages = stageNames.map((name) => {
    const inStage = open.filter((l) => l.status === name);
    return { key: name, name, count: inStage.length, value: inStage.reduce((a, l) => a + l.value, 0) };
  });
  // Leads in a stage that was since removed from the master list still count as open pipeline.
  const orphan = open.filter((l) => !stageNames.includes(l.status));
  if (orphan.length) stages.push({ key: 'other', name: 'Other', count: orphan.length, value: orphan.reduce((a, l) => a + l.value, 0) });

  const wonMonth = within(won, P.month.from, P.month.to);
  const ownerRows = owners.map((o) => {
    const mine = open.filter((l) => l.owner === o.id);
    return {
      id: o.id,
      name: o.name,
      hue: o.hue,
      open: mine.length,
      value: mine.reduce((a, l) => a + l.value, 0),
      wonMonth: wonMonth.filter((l) => l.owner === o.id).reduce((a, l) => a + l.value, 0),
      overdue: openFus.filter((f) => f.owner_id === o.id && ms(f.due_at) < now).length,
    };
  });

  // Team
  const team = people.map((p) => personRow(p, live, P.T))
    .sort((a, b) => STATE_ORDER[stateOf(a)] - STATE_ORDER[stateOf(b)] || a.name.localeCompare(b.name));
  const count = (s) => team.filter((x) => stateOf(x) === s).length;

  // Weekly revenue won (Monday-based weeks, oldest first, the current week last)
  const firstWeek = addDays(P.weekStart, -7 * (WEEKS - 1));
  const weekly = Array.from({ length: WEEKS }, (_, i) => {
    const from = addDays(firstWeek, 7 * i);
    return { weekOf: iso(from), value: total(within(won, from, addDays(from, 7))).value };
  });

  const more = await extras(P, now, people, live);

  return {
    company: 'mariox',
    syncedAt: iso(now),
    sales: {
      won: { today: wonBlock(won, P.today), week: wonBlock(won, P.week), month: wonBlock(won, P.month) },
      lost: { month: total(within(lost, P.month.from, P.month.to)), topReason: null },
      newDeals: { today: num(newToday && newToday.n), week: num(newWeek && newWeek.n) },
      winRateQuarter: quarter.length ? Math.round((qWon / quarter.length) * 100) / 100 : 0,
      stages,
      owners: ownerRows,
      followUps: { dueToday: openFus.filter((f) => ms(f.due_at) >= P.T && ms(f.due_at) < addDays(P.T, 1)).length },
    },
    cash: null,
    changeRequests: { waitingOnClient: num(crs && crs.n), value: num(crs && crs.v) },
    bugs: {
      open: num(bugsOpen && bugsOpen.n),
      critical: critical.map((b) => ({ id: b.id, projectId: b.project_id, projectName: b.project_name, openedAt: dayIso(b.reported_on) })),
    },
    projects: {
      running: projects.length,
      list: projects.map((p) => projectRow(p, msBy[p.id] || [], loggedBy[p.id] || 0))
        .sort((a, b) => (ms(a.milestone.due) ?? Infinity) - (ms(b.milestone.due) ?? Infinity)),
      onHold: more.onHold,
    },
    reports: more.reports,
    quotes: more.quotes,
    teamTasks: more.teamTasks,
    team: {
      size: team.length,
      in: count('in'),
      onBreak: count('break'),
      left: count('left'),
      notIn: count('out'),
      late: team.filter((x) => x.late).length,
      hoursToday: Math.round(num(logsToday && logsToday.h) * 10) / 10,
      people: team,
      days: history,
    },
    weekly,
  };
}
