/**
 * Pure business rules ported from the frontend:
 *   ../frontend/src/domain/projects.js            (buildProjectsModel → info() health, crRate, costOf, crMoney, printCr, curMs)
 *   ../frontend/src/features/projects/tabs/*.jsx  (Overview numbers, Capacity algorithm)
 * Everything works on API-shaped objects (camelCase) with days as 'YYYY-MM-DD' strings.
 */
import { dn, ds, todayN, periodRange, workdaysBetween, workdaysSoFar, isSundayN } from './dates.js';

export const PROJECT_STATUSES = ['Running', 'On hold', 'Completed', 'Planning', 'Cancelled'];
export const MILESTONE_STATUSES = ['Not started', 'In progress', 'In review', 'Done'];
export const CR_STATUSES = ['Draft', 'Sent to client', 'Approved', 'In progress', 'Done', 'Rejected'];
export const TEAMS = ['Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO'];
export const TEAM_COST = { Web: 700, Mobile: 750, Backend: 750, Design: 650, QA: 550, PMO: 900 };
export const MILESTONE_TEMPLATE = {
  fractions: [0.15, 0.3, 0.3, 0.15, 0.1],
  names: ['Feature List', 'UI/UX Milestone 1', 'Frontend Milestone 2', 'Backend Milestone 3', 'QA, Third Party, Go Live - Milestone 4'],
};
export const LINK_TYPES = ['Figma', 'Prototype', 'Google Drive', 'Repository', 'Staging URL', 'Live URL', 'Jira / tracker', 'Other'];
/** Link types shown to the client in the portal. */
export const REVIEW_LINKS = ['Staging URL', 'Prototype', 'Figma', 'Live URL'];
export const LINK_OK = /^https?:\/\//i;
const PERIOD_LABELS = {
  today: 'Today', yesterday: 'Yesterday', week: 'This week', '7d': 'Last 7 days', month: 'This month',
  lastmonth: 'Last month', '30d': 'Last 30 days', '90d': 'Last 90 days', all: 'All time', custom: 'Custom range',
};

/* ───────────── Formatting (lib/format.js) ───────────── */

/** "12.5h" */
export const hh = (x) => `${(Math.round((+x || 0) * 10) / 10).toLocaleString('en-IN')}h`;
/** Compact money label honouring the currency setting (INR | USD). */
export function money(v, currency = 'INR') {
  v = +v || 0;
  if (currency === 'USD') {
    v /= 84;
    return v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`;
  }
  return v >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${(v / 1e5).toFixed(1)} L` : `₹${Math.round(v).toLocaleString('en-IN')}`;
}
/** ₹1,25,000 */
export const inr = (v) => `₹${Math.round(+v || 0).toLocaleString('en-IN')}`;
/** "9 Nov 2026, 3:30 pm" */
export const dateTime = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "9 Nov 2026" */
export const fd = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ───────────── Small rules ───────────── */

/** Current milestone id of a project: first not-Done (by n), else the last; '' if none. */
export function curMs(milestones, pid) {
  const a = milestones.filter((m) => m.projectId === pid).sort((x, y) => x.n - y.n);
  return ((a.find((m) => m.status !== 'Done') || a[a.length - 1]) || {}).id || '';
}

/** Default CR hourly rate: contract value / base (non-CR) budget, rounded to 50 (else 1500). */
export function crRate(milestones, p) {
  const b = milestones.filter((m) => m.projectId === p.id && !m.crId).reduce((x, m) => x + (+m.allocHours || 0), 0);
  return b && p.value ? Math.round(p.value / b / 50) * 50 : 1500;
}

/** Internal hourly cost of a member. */
export function costOf(members, id) {
  const m = (members || []).find((x) => x.id === id) || {};
  return +m.costPerHour || TEAM_COST[m.team] || 700;
}

/**
 * Money picture of a change request (crMoney). `c.tasks` = [{title, assigneeId, hours}].
 * used/cost/profit are null until the CR has its own (CR) milestone.
 */
export function crMoney(c, { logs = [], milestones = [], members = [] }) {
  const ls = c.milestoneId ? logs.filter((l) => l.milestoneId === c.milestoneId) : [];
  const sep = !!c.milestoneId && milestones.some((m) => m.id === c.milestoneId && m.crId);
  const used = sep ? ls.reduce((x, l) => x + l.hours, 0) : null;
  const cost = sep ? ls.reduce((x, l) => x + l.hours * costOf(members, l.memberId), 0) : null;
  const tk = c.tasks || [];
  const tH = tk.reduce((x, t) => x + (+t.hours || 0), 0);
  const avg = tk.length && tH
    ? tk.reduce((x, t) => x + (+t.hours || 0) * costOf(members, t.assigneeId), 0) / tH
    : (c.team || []).length ? c.team.reduce((x, id) => x + costOf(members, id), 0) / c.team.length : 700;
  const estCost = c.hours * avg;
  return {
    used, cost, estCost, estProfit: (c.amount || 0) - estCost, profit: cost != null ? (c.amount || 0) - cost : null,
    over: used != null && used > c.hours, near: used != null && used >= c.hours * 0.9 && used <= c.hours,
  };
}

/* ───────────── Projects model (buildProjectsModel) ───────────── */

const zero = () => ({ all: 0, today: 0, yest: 0, week: 0, month: 0, range: 0 });
const ZERO = Object.freeze(zero());

/**
 * @param data { projects, milestones, logs, members, blocked: {pid: n}, critical: {pid: n} }
 *   project: { id, name, client, status, pmId, startDate, dueDate, value, team:[{memberId, allocHours}] }
 *   milestone: { id, projectId, n, name, allocHours, dueDate, status, crId }
 *   log: { memberId, projectId, milestoneId, day, hours }
 *   member: { id, name, roleTitle, team, shiftHours, costPerHour }
 * @param f filters { q, status, team, member, project, period, from, to }
 */
export function buildModel(data, f = {}, T = todayN()) {
  const { projects, milestones, logs, members } = data;
  const blocked = data.blocked || {};
  const critical = data.critical || {};
  const MEM = Object.fromEntries(members.map((m) => [m.id, m]));
  const PRJ = Object.fromEntries(projects.map((p) => [p.id, p]));
  const msOf = {};
  milestones.forEach((m) => { (msOf[m.projectId] = msOf[m.projectId] || []).push(m); });
  Object.values(msOf).forEach((a) => a.sort((x, y) => x.n - y.n));
  const teamIds = (p) => p.team.map((t) => t.memberId);

  const period = f.period || 'week';
  const rg = periodRange(period, f.from, f.to, T);
  const wk = periodRange('week', null, null, T);
  const mo = periodRange('month', null, null, T);
  const inR = (d) => !rg || (d >= rg[0] && d < rg[1]);

  const A = {};
  const g = (k) => A[k] || ZERO;
  const add = (k, l, d) => {
    const a = A[k] || (A[k] = zero());
    a.all += l.hours;
    if (d === T) a.today += l.hours;
    if (d === T - 1) a.yest += l.hours;
    if (d >= wk[0] && d < wk[1]) a.week += l.hours;
    if (d >= mo[0] && d < mo[1]) a.month += l.hours;
    if (inR(d)) a.range += l.hours;
  };
  const msPeople = {};
  logs.forEach((l) => {
    const d = dn(l.day);
    l.dn = d;
    const tm = (MEM[l.memberId] || {}).team;
    add(`p:${l.projectId}`, l, d); add(`m:${l.memberId}`, l, d); add(`pm:${l.projectId}:${l.memberId}`, l, d);
    add(`pt:${l.projectId}:${tm}`, l, d); add(`ms:${l.milestoneId}`, l, d); add(`d:${l.memberId}:${d}`, l, d);
    const s = msPeople[l.milestoneId] || (msPeople[l.milestoneId] = []);
    if (!s.includes(l.memberId)) s.push(l.memberId);
  });
  const sumA = (list) => list.reduce((x, a) => ({
    all: x.all + a.all, today: x.today + a.today, yest: x.yest + a.yest, week: x.week + a.week, month: x.month + a.month, range: x.range + a.range,
  }), zero());

  const q = (f.q || '').trim().toLowerCase();
  const pBase = projects.filter((p) => (!q || `${p.name} ${p.client} ${p.id} ${teamIds(p).map((id) => (MEM[id] || {}).name).join(' ')}`.toLowerCase().includes(q))
    && (!f.project || p.id === f.project)
    && (!f.member || teamIds(p).includes(f.member))
    && (!f.team || teamIds(p).some((id) => (MEM[id] || {}).team === f.team)));
  const pF = f.status ? pBase.filter((p) => p.status === f.status) : pBase;
  const pSet = new Set(pF.map((p) => p.id));
  const hk = (p) => (f.member ? `pm:${p.id}:${f.member}` : f.team ? `pt:${p.id}:${f.team}` : `p:${p.id}`);
  const LF = logs.filter((l) => pSet.has(l.projectId) && (!f.member || l.memberId === f.member) && (!f.team || (MEM[l.memberId] || {}).team === f.team));
  const projScoped = !!(q || f.project || f.status);
  const memF = members.filter((m) => (!f.member || m.id === f.member) && (!f.team || m.team === f.team)
    && (!projScoped || pF.some((p) => teamIds(p).includes(m.id)) || (q && `${m.name} ${m.roleTitle || ''}`.toLowerCase().includes(q))));

  /** Budget, progress and health of a project (info()). */
  const info = (p) => {
    const ms = msOf[p.id] || [];
    const budget = p.budgetHours != null ? +p.budgetHours : ms.reduce((x, m) => x + (+m.allocHours || 0), 0);
    const used = g(`p:${p.id}`).all;
    const curM = ms.find((m) => m.status !== 'Done');
    const ci = curM ? ms.indexOf(curM) : ms.length;
    const start = dn(p.startDate);
    const due = dn(p.dueDate);
    const dd = due - T;
    let hl;
    let sc = null;
    const why = [];
    if (p.status === 'Completed') hl = budget && used > budget * 1.02 ? ['Over budget', 25] : ['Delivered', 150];
    else if (p.status === 'Planning') hl = ['Not started', 265];
    else if (p.status === 'Cancelled') hl = ['Cancelled', 265];
    else {
      sc = 100;
      const odMs = ms.filter((m) => m.status !== 'Done' && m.dueDate && dn(m.dueDate) < T);
      const done = ms.filter((m) => m.status === 'Done').length;
      const prog = ms.length ? (done + (curM && curM.status !== 'Not started' ? 0.5 : 0)) / ms.length : 0;
      const el = Math.max(0, Math.min(1, (T - start) / Math.max(1, due - start)));
      const bp = budget ? used / budget : 0;
      const crit = critical[p.id] || 0;
      const blk = blocked[p.id] || 0;
      const pen = (n, t) => { if (n > 0) { sc -= n; why.push(t); } };
      if (dd < 0) pen(35, `${Math.abs(dd)}d past the due date`);
      pen(Math.min(30, odMs.length * 15), `${odMs.length} milestone${odMs.length > 1 ? 's' : ''} overdue`);
      if (budget && used > budget) pen(25, `${hh(used - budget)} over the hours budget`);
      else if (budget && bp - prog > 0.15) pen(bp - prog > 0.3 ? 20 : 10, `${Math.round(bp * 100)}% of hours used, ${Math.round(prog * 100)}% delivered`);
      if (el - prog > 0.2) pen(15, `${Math.round(el * 100)}% of the timeline gone, ${Math.round(prog * 100)}% delivered`);
      pen(Math.min(24, crit * 8), `${crit} critical bug${crit > 1 ? 's' : ''} open`);
      pen(Math.min(15, blk * 5), `${blk} blocked task${blk > 1 ? 's' : ''}`);
      if (p.status === 'On hold') pen(10, 'Project is on hold');
      sc = Math.max(0, sc);
      hl = dd < 0 || odMs.some((m) => T - dn(m.dueDate) > 7) ? ['Late', 25] : sc < 75 ? ['At risk', 70] : ['On track', 150];
    }
    return {
      p, ms, budget, used, curM, ci, pct: budget ? used / budget : 0, dd,
      health: { label: hl[0], score: sc, reasons: why, hue: hl[1], bad: hl[1] === 25 || hl[1] === 70 },
    };
  };

  return { T, MEM, PRJ, msOf, msPeople, g, sumA, hk, inR, rg, wk, mo, q, pBase, pF, pSet, LF, projScoped, memF, info, periodLabel: PERIOD_LABELS[period] || 'Period' };
}

/** List row for a project (projectRow + info). */
export function projectSummary(p, M) {
  const I = M.info(p);
  const H = M.g(M.hk(p));
  const n = I.ms.length;
  return {
    budgetHours: I.budget,
    hours: { used: I.used, period: H.range, today: H.today, yesterday: H.yest, week: H.week, month: H.month },
    usedPct: Math.round(I.pct * 100),
    currentMilestone: I.curM ? { id: I.curM.id, n: I.curM.n, name: I.curM.name, status: I.curM.status, step: I.ci + 1, of: n } : null,
    milestonesDone: I.ms.filter((m) => m.status === 'Done').length,
    milestoneCount: n,
    daysToDue: I.dd,
    health: { label: I.health.label, score: I.health.score, reasons: I.health.reasons },
  };
}

/* ───────────── Overview tab ───────────── */

export function overview(M, { projects, logs }) {
  const { T, LF, pBase, pF, pSet, memF, projScoped, g, hk, inR, wk, mo, MEM, info } = M;
  const sumL = (fn) => LF.reduce((x, l) => x + (fn(l) ? l.hours : 0), 0);
  const yd = T - 1;
  const tH = sumL((l) => l.dn === T);
  const yH = sumL((l) => l.dn === yd);
  const wH = sumL((l) => l.dn >= wk[0] && l.dn < wk[1]);
  const mH = sumL((l) => l.dn >= mo[0] && l.dn < mo[1]);
  const actM = memF.filter((m) => projects.some((p) => p.status === 'Running' && p.team.some((t) => t.memberId === m.id) && (!projScoped || pSet.has(p.id))));
  const shiftSum = actM.reduce((x, m) => x + (+m.shiftHours || 8), 0);
  const yOff = isSundayN(yd);
  const expW = shiftSum * workdaysSoFar(wk[0], wk[1], T);
  const expM = shiftSum * workdaysSoFar(mo[0], mo[1], T);
  const missingM = actM.filter((m) => g(`d:${m.id}:${T}`).all === 0);
  const lastLog = (id) => logs.reduce((best, l) => (l.memberId === id && (!best || l.day > best) ? l.day : best), null);
  const contract = (list) => list.reduce((x, p) => x + (p.value || 0), 0);

  const pr = pF.map((p) => ({ p, h: g(hk(p)).range })).filter((x) => x.h > 0).sort((a, b) => b.h - a.h).slice(0, 8);
  const tb = TEAMS.map((t) => ({ t, h: LF.reduce((x, l) => x + ((MEM[l.memberId] || {}).team === t && inR(l.dn) ? l.hours : 0), 0) }))
    .filter((x) => x.h > 0).sort((a, b) => b.h - a.h);

  return {
    periodLabel: M.periodLabel,
    statusCards: [
      { status: '', label: 'All projects', count: pBase.length, contractValue: contract(pBase) },
      ...PROJECT_STATUSES.map((k) => {
        const a = pBase.filter((p) => p.status === k);
        return { status: k, label: k, count: a.length, contractValue: contract(a) };
      }),
    ],
    hourCards: {
      today: { hours: tH, expected: shiftSum, missing: missingM.length, activeMembers: actM.length },
      yesterday: { hours: yH, expected: yOff ? 0 : shiftSum, weeklyOff: yOff },
      week: { hours: wH, expected: expW },
      month: { hours: mH, expected: expM },
    },
    hoursByProject: pr.map((x) => ({ projectId: x.p.id, name: x.p.name, hours: x.h })),
    hoursByTeam: tb.map((x) => ({ team: x.t, hours: x.h })),
    missingTimesheets: missingM.map((m) => ({ memberId: m.id, name: m.name, roleTitle: m.roleTitle, team: m.team, lastLoggedDay: lastLog(m.id) })),
    needsAttention: pF.map(info)
      .filter((I) => I.health.bad && I.p.status !== 'Completed')
      .sort((a, b) => (a.health.score ?? 100) - (b.health.score ?? 100))
      .map((I) => ({
        projectId: I.p.id,
        name: I.p.name,
        health: { label: I.health.label, score: I.health.score, reasons: I.health.reasons },
        sub: I.health.reasons.length
          ? I.health.reasons.join(' · ')
          : I.health.label === 'At risk'
            ? `${Math.round(I.pct * 100)}% of budget used · due ${fd(I.p.dueDate)}`
            : `${I.health.label} · ${I.curM ? I.curM.name : ''}`,
      })),
  };
}

/* ───────────── Capacity tab ───────────── */

const CAP_STATES = { over: 'Overbooked', full: 'Fully booked', free: 'Has free time' };
const WEEK_LABELS = ['This week', 'Next week', 'In 2 weeks'];

/**
 * For week `capW` (0..2) spread each member's remaining project hours evenly over the working days
 * up to the project's due date (overdue projects: two more weeks) and compare with their shift.
 */
export function capacity(M, { projects, tasks = [] }, capW = 0) {
  const { T, wk, memF, info, g } = M;
  const cw0 = wk[0] + capW * 7;
  const cDays = Array.from({ length: 7 }, (_, i) => cw0 + i).filter((d) => !isSundayN(d));
  const capProj = projects.filter((p) => p.status === 'Running' || p.status === 'Planning');
  const pEnd = (p) => (dn(p.dueDate) < T ? T + 13 : dn(p.dueDate));
  const rate = {};
  capProj.forEach((p) => {
    const I = info(p);
    const left = workdaysBetween(Math.max(T, dn(p.startDate)), pEnd(p));
    const remB = Math.max(0, I.budget - I.used);
    p.team.forEach(({ memberId: mid, allocHours }) => {
      const a = +allocHours || 0;
      const rem = a ? Math.max(0, a - g(`pm:${p.id}:${mid}`).all) : remB / p.team.length;
      rate[`${p.id}:${mid}`] = rem / left;
    });
  });
  const on = (p, d) => d >= dn(p.startDate) && d <= pEnd(p);
  const r2 = (x) => Math.round(x * 100) / 100;
  const all = memF.map((m) => {
    const sh = +m.shiftHours || 8;
    const cap = sh * cDays.length;
    const mp = capProj.filter((p) => p.team.some((t) => t.memberId === m.id));
    const per = cDays.map((d) => mp.filter((p) => on(p, d)).reduce((x, p) => x + rate[`${p.id}:${m.id}`], 0));
    const booked = per.reduce((a, b) => a + b, 0);
    const u = cap ? booked / cap : 0;
    const k = u > 1.1 ? 'over' : u >= 0.85 ? 'full' : 'free';
    const byP = mp
      .map((p) => ({ projectId: p.id, name: p.name, hours: cDays.filter((d) => on(p, d)).length * rate[`${p.id}:${m.id}`] }))
      .filter((x) => x.hours >= 0.5)
      .sort((a, b) => b.hours - a.hours);
    const tks = tasks.filter((t) => t.assigneeId === m.id && t.status !== 'Done' && t.dueDate && dn(t.dueDate) >= cDays[0] && dn(t.dueDate) < cw0 + 7);
    return {
      memberId: m.id, name: m.name, team: m.team, roleTitle: m.roleTitle, shiftHours: sh,
      state: k, stateLabel: CAP_STATES[k], utilization: r2(u), booked: r2(booked), capacity: cap,
      free: r2(Math.max(0, cap - booked)), over: r2(Math.max(0, booked - cap)),
      days: per.map((h, i) => ({ day: ds(cDays[i]), hours: r2(h), ratio: r2(h / sh) })),
      projects: byP.slice(0, 3).map((x) => ({ ...x, hours: r2(x.hours) })),
      tasksDue: { count: tks.length, estimateHours: tks.reduce((x, t) => x + (+t.estimateHours || 0), 0) },
    };
  }).sort((a, b) => b.utilization - a.utilization);
  const sumB = all.reduce((x, c) => x + c.booked, 0);
  const sumC = all.reduce((x, c) => x + c.capacity, 0);
  const n = (k) => all.filter((x) => x.state === k).length;
  return {
    week: capW,
    label: WEEK_LABELS[capW] || 'In 2 weeks',
    days: cDays.map(ds),
    bookedPct: sumC ? Math.round((sumB / sumC) * 100) : 0,
    unbookedHours: r2(Math.max(0, sumC - sumB)),
    counts: { all: all.length, over: n('over'), full: n('full'), free: n('free') },
    members: all,
  };
}

/** Milestone template for a new project (saveProj). Returns [{n, name, allocHours, dueDate}]. */
export function templateMilestones(budget, startDate, dueDate) {
  const start = dn(startDate);
  const span = dn(dueDate) - start;
  let cum = 0;
  return MILESTONE_TEMPLATE.fractions.map((fr, i) => {
    cum += fr;
    return { n: i + 1, name: MILESTONE_TEMPLATE.names[i], allocHours: Math.round((budget * fr) / 5) * 5, dueDate: ds(start + Math.floor(span * cum + 0.5)) };
  });
}
