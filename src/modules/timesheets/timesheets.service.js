import { db } from '../../db/knex.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { nextId } from '../../core/ids.js';
import { pageParams, sortParam } from '../../core/http.js';
import { peopleScope, visibleProjectIds } from '../../core/scope.js';
import { curMs, findMember, findMilestone } from '../tasks/tasks.repository.js';
import * as repo from './timesheets.repository.js';
import { addDays, monthOf, range, today, weekOf, workdaysSoFar } from './period.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
const r2 = (n) => Math.round(Number(n) * 100) / 100;

export const toLog = (r) => ({
  id: r.id,
  memberId: r.member_id,
  memberName: r.member_name ?? null,
  team: r.member_team ?? null,
  projectId: r.project_id,
  projectName: r.project_name ?? null,
  milestoneId: r.milestone_id,
  milestoneName: r.milestone_name ?? null,
  date: r.day,
  hours: Number(r.hours),
  note: r.note,
  source: r.source,
  createdAt: iso(r.created_at),
});

/** Row scope for logs (frontend scopeState): visible projects AND member within the ts scope. */
export async function logScope(user) {
  const [projectIds, ps] = await Promise.all([visibleProjectIds(user), peopleScope(user, 'ts')]);
  return { projectIds, people: ps.people, scope: ps.scope };
}

const periodOf = (f) => range(f.date, f.from, f.to);
const days = (rg) => {
  const T = today();
  return { today: T, yesterday: addDays(T, -1), week: weekOf(T), month: monthOf(T), range: rg };
};

export async function list(user, f) {
  const scope = await logScope(user);
  const page = pageParams(f);
  const sort = sortParam(f.sort, repo.LOG_SORTS, null);
  const { rows, total, hours } = await repo.list(scope, f, periodOf(f), sort, page);
  return { data: rows.map(toLog), meta: { ...page.meta(total), totalHours: hours } };
}

export async function summary(user, f) {
  const scope = await logScope(user);
  const rg = periodOf(f);
  const s = await repo.summary(scope, f, days(rg));
  return { ...s, from: rg ? rg[0] : null, to: rg && rg[1] ? addDays(rg[1], -1) : null };
}

/** Member × project matrix for the range (TimesheetsTab "Member × project"). */
export async function matrix(user, f) {
  const scope = await logScope(user);
  const cells = await repo.matrix(scope, f, periodOf(f));
  const cols = new Map();
  const rows = new Map();
  let max = 0;
  for (const c of cells) {
    const h = Number(c.hours);
    if (!(h > 0)) continue;
    if (!cols.has(c.project_id)) cols.set(c.project_id, { projectId: c.project_id, name: c.project_name, hue: c.project_hue, total: 0 });
    if (!rows.has(c.member_id)) rows.set(c.member_id, { memberId: c.member_id, name: c.member_name, team: c.member_team, hue: c.member_hue, total: 0, cells: {} });
    const row = rows.get(c.member_id);
    row.cells[c.project_id] = h;
    row.total += h;
    cols.get(c.project_id).total += h;
    max = Math.max(max, h);
  }
  const columns = [...cols.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c, total: r2(c.total) }));
  const out = [...rows.values()].map((r) => ({
    memberId: r.memberId, name: r.name, team: r.team, hue: r.hue, total: r2(r.total),
    cells: columns.map((c) => ({ projectId: c.projectId, hours: r.cells[c.projectId] || 0 })),
  }));
  return {
    columns,
    rows: out,
    totals: columns.map((c) => ({ projectId: c.projectId, hours: c.total })),
    grand: r2(columns.reduce((x, c) => x + c.total, 0)),
    max,
  };
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const CSV_HEAD = ['Date', 'Member', 'Team', 'Project', 'Milestone', 'Hours', 'Work done'];

/** CSV of the filtered entries (same columns as the frontend export). */
export async function exportCsv(user, f) {
  const scope = await logScope(user);
  const rows = await repo.all(scope, f, periodOf(f));
  const lines = [CSV_HEAD, ...rows.map((l) => [l.day, l.member_name, l.member_team, l.project_name, l.milestone_name, Number(l.hours), l.note])];
  return { csv: `${lines.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`, count: rows.length, filename: `mariox-timesheets-${today()}.csv` };
}

/**
 * saveLog: { memberId, date, rows:[{projectId, milestoneId?, hours, note}] }.
 * Own-scope users log only for themselves, team scope only for their team. Hours round to 0.25;
 * a member's day can't exceed 24h. Milestone defaults to the project's current milestone.
 */
export async function create(user, body) {
  const scope = await logScope(user);
  const memberId = body.memberId || user.memberId;
  if (!memberId) throw unprocessable('Pick a team member.');
  if (scope.people && !scope.people.includes(memberId)) {
    throw forbidden(scope.scope === 'own' ? 'You can only log your own hours' : 'You can only log hours for your team');
  }
  if (!body.date) throw unprocessable('Pick a date.');
  const rows = body.rows.filter((r) => r.projectId && r.hours > 0);
  if (!rows.length) throw unprocessable('Enter hours for at least one project.');
  const tot = rows.reduce((x, r) => x + r.hours, 0);
  for (const r of rows) {
    if (scope.projectIds && !scope.projectIds.includes(r.projectId)) throw forbidden("You don't have access to this project");
  }

  return db.transaction(async (trx) => {
    if (!(await findMember(trx, memberId))) throw unprocessable('Pick a team member.');
    // Serialise concurrent saves for the same member + day so the 24h rule holds.
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`ts:${memberId}:${body.date}`]);
    const ex = await repo.dayTotal(trx, memberId, body.date);
    if (tot + ex > 24) throw unprocessable('That adds up to more than 24 hours for one day.');
    const ids = [];
    for (const r of rows) {
      const hours = Math.round(r.hours * 4) / 4;
      if (!(hours > 0)) continue;
      let ms = r.milestoneId;
      if (ms) {
        const m = await findMilestone(trx, ms);
        if (!m || m.project_id !== r.projectId) throw unprocessable('Pick a milestone of this project.');
      } else {
        ms = await curMs(trx, r.projectId);
      }
      const id = await nextId(trx, 'log');
      await trx('time_logs').insert({ id, member_id: memberId, project_id: r.projectId, milestone_id: ms, day: body.date, hours, note: (r.note || '').trim(), source: 'manual' });
      ids.push(id);
    }
    if (!ids.length) throw unprocessable('Enter hours for at least one project.');
    const saved = await repo.base({}, {}, trx).whereIn('l.id', ids).select('l.*', 'mb.name as member_name', 'mb.team as member_team',
      'p.name as project_name', 'm.name as milestone_name').orderBy('l.id');
    return saved.map(toLog);
  });
}

export async function remove(user, id) {
  const scope = await logScope(user);
  const row = await repo.getById(scope, id);
  if (!row) throw notFound('Time entry');
  await db('time_logs').where({ id }).del();
}

/**
 * Team & hours (TeamTab): one row per member with today / yesterday / week / month / period hours,
 * shift, allocation vs hours taken on active projects, utilisation and "not submitted" today.
 * When a project / status / search filter is set, hours and allocation only count those projects.
 */
export async function teamHours(user, f) {
  const [visible, ps] = await Promise.all([visibleProjectIds(user), peopleScope(user, 'team')]);
  const projScoped = !!(f.q || f.project || f.status);

  let projectIds = visible;
  if (projScoped) {
    const pq = db('projects as p');
    if (visible) pq.whereIn('p.id', visible.length ? visible : ['__none__']);
    if (f.project) pq.where('p.id', f.project);
    if (f.status) pq.where('p.status', f.status);
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      pq.where((w) => w.whereILike('p.name', like).orWhereILike('p.client', like).orWhereILike('p.id', like)
        .orWhereExists(db('project_members as x').join('members as y', 'y.id', 'x.member_id').whereRaw('x.project_id = p.id').whereILike('y.name', like)));
    }
    projectIds = await pq.pluck('p.id');
  }

  const mq = db('members as mb').where('mb.active', true);
  if (ps.people) mq.whereIn('mb.id', ps.people.length ? ps.people : ['__none__']);
  if (f.member) mq.where('mb.id', f.member);
  if (f.team) mq.where('mb.team', f.team);
  if (projScoped) {
    mq.where((w) => {
      w.whereExists(db('project_members as x').whereRaw('x.member_id = mb.id').whereIn('x.project_id', projectIds.length ? projectIds : ['__none__']));
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        w.orWhereILike('mb.name', like).orWhereILike('mb.role_title', like);
      }
    });
  }
  const page = pageParams(f, { defaultSize: 100 });
  const [{ count }] = await mq.clone().count('* as count');
  const members = await mq.clone().select('mb.*').orderBy('mb.name').limit(page.limit).offset(page.offset);
  const ids = members.map((m) => m.id);

  const rg = periodOf(f);
  const [hrs, alloc] = await Promise.all([repo.memberHours(ids, projectIds, days(rg)), repo.allocation(ids, projectIds)]);
  const H = Object.fromEntries(hrs.map((h) => [h.member_id, h]));
  const A = Object.fromEntries(alloc.map((a) => [a.member_id, a]));
  const wk = weekOf();
  const wd = workdaysSoFar(wk[0], wk[1]);

  const rows = members.map((m) => {
    const h = H[m.id] || {};
    const a = A[m.id] || {};
    const hours = Object.fromEntries(['today', 'yesterday', 'week', 'month', 'range', 'all'].map((k) => [k, r2(h[k] || 0)]));
    const sh = Number(m.shift_hours) || 8;
    const allocated = r2(a.allocated || 0);
    const taken = r2(a.taken || 0);
    const u = allocated ? taken / allocated : 0;
    return {
      memberId: m.id, name: m.name, roleTitle: m.role_title, team: m.team, hue: m.hue, shiftHours: sh,
      hours,
      weekExpected: r2(sh * wd),
      allocated, taken, utilisation: Math.round(u * 1000) / 1000, utilisationPct: allocated ? Math.round(u * 100) : null,
      projects: Number(a.projects || 0),
      notSubmitted: !!a.running && hours.today === 0 && !projScoped,
      todayState: hours.today > sh ? 'overtime' : hours.today >= sh ? 'full' : 'short',
    };
  });
  return { data: rows, meta: { ...page.meta(Number(count)), from: rg ? rg[0] : null, to: rg && rg[1] ? addDays(rg[1], -1) : null } };
}
