import { db } from '../../db/knex.js';
import { whereInRange } from './period.js';

const COLS = ['l.*', 'mb.name as member_name', 'mb.team as member_team', 'p.name as project_name', 'p.hue as project_hue', 'm.name as milestone_name'];
export const LOG_SORTS = { date: 'l.day', hours: 'l.hours', member: 'mb.name', project: 'p.name', created: 'l.created_at' };

/** Logs within scope { projectIds, people } + filters (member / project / team / milestone). */
export function base(scope, f, q = db) {
  const b = q('time_logs as l')
    .join('members as mb', 'mb.id', 'l.member_id')
    .join('projects as p', 'p.id', 'l.project_id')
    .leftJoin('milestones as m', 'm.id', 'l.milestone_id');
  if (scope.projectIds) b.whereIn('l.project_id', scope.projectIds.length ? scope.projectIds : ['__none__']);
  if (scope.people) b.whereIn('l.member_id', scope.people.length ? scope.people : ['__none__']);
  if (f.member) b.where('l.member_id', f.member);
  if (f.project) b.where('l.project_id', f.project);
  if (f.team) b.where('mb.team', f.team);
  if (f.milestone) b.where('l.milestone_id', f.milestone);
  return b;
}

export async function list(scope, f, rg, sort, page) {
  const b = whereInRange(base(scope, f), 'l.day', rg);
  const [{ count, hours }] = await b.clone().select(db.raw('count(*)::int as count, coalesce(sum(l.hours), 0) as hours'));
  const rows = b.clone().select(COLS).limit(page.limit).offset(page.offset);
  if (sort) rows.orderBy(sort[0], sort[1]);
  rows.orderBy([{ column: 'l.day', order: 'desc' }, { column: 'mb.name' }, { column: 'l.id' }]);
  return { rows: await rows, total: count, hours: Number(hours) };
}

/** Every matching entry (CSV export), newest first. */
export const all = (scope, f, rg) => whereInRange(base(scope, f), 'l.day', rg).select(COLS)
  .orderBy([{ column: 'l.day', order: 'desc' }, { column: 'mb.name' }, { column: 'l.id' }]);

/** Hours today / yesterday / this week / this month / in range / all time, + entry count in range. */
export async function summary(scope, f, d) {
  const inR = rangeSql(d.range);
  const [r] = await base(scope, f).select(db.raw(`
    coalesce(sum(l.hours) filter (where l.day = ?), 0) as today,
    coalesce(sum(l.hours) filter (where l.day = ?), 0) as yesterday,
    coalesce(sum(l.hours) filter (where l.day >= ? and l.day < ?), 0) as week,
    coalesce(sum(l.hours) filter (where l.day >= ? and l.day < ?), 0) as month,
    coalesce(sum(l.hours) filter (where ${inR.sql}), 0) as range,
    coalesce(sum(l.hours), 0) as all,
    (count(*) filter (where ${inR.sql}))::int as entries`, [d.today, d.yesterday, ...d.week, ...d.month, ...inR.args, ...inR.args]));
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

/** sum(...) filter (where <range>) for an optional [from, toExclusive) — `true` when unbounded. */
function rangeSql(rg) {
  const parts = [];
  const args = [];
  if (rg && rg[0]) { parts.push('l.day >= ?'); args.push(rg[0]); }
  if (rg && rg[1]) { parts.push('l.day < ?'); args.push(rg[1]); }
  return { sql: parts.length ? parts.join(' and ') : 'true', args };
}

/** Member × project hours in the range. */
export const matrix = (scope, f, rg) => whereInRange(base(scope, f), 'l.day', rg)
  .groupBy('l.member_id', 'mb.name', 'mb.team', 'mb.hue', 'l.project_id', 'p.name', 'p.hue')
  .select('l.member_id', 'mb.name as member_name', 'mb.team as member_team', 'mb.hue as member_hue', 'l.project_id', 'p.name as project_name', 'p.hue as project_hue',
    db.raw('sum(l.hours) as hours'))
  .orderBy([{ column: 'mb.name' }, { column: 'p.name' }]);

/** Existing hours of a member on a day (for the 24h rule). */
export async function dayTotal(q, memberId, day) {
  const [{ h }] = await q('time_logs').where({ member_id: memberId, day }).select(q.raw('coalesce(sum(hours), 0) as h'));
  return Number(h);
}

export const getById = (scope, id, q = db) => base(scope, {}, q).where('l.id', id).first(COLS);

/* ── Team & hours ── */

/**
 * Per-member hour aggregates over logs of the given projects (null = unrestricted) for the given members.
 */
export async function memberHours(memberIds, projectIds, d) {
  if (!memberIds.length) return [];
  const inR = rangeSql(d.range);
  const b = db('time_logs as l').whereIn('l.member_id', memberIds);
  if (projectIds) b.whereIn('l.project_id', projectIds.length ? projectIds : ['__none__']);
  return b.groupBy('l.member_id').select('l.member_id', db.raw(`
    coalesce(sum(l.hours) filter (where l.day = ?), 0) as today,
    coalesce(sum(l.hours) filter (where l.day = ?), 0) as yesterday,
    coalesce(sum(l.hours) filter (where l.day >= ? and l.day < ?), 0) as week,
    coalesce(sum(l.hours) filter (where l.day >= ? and l.day < ?), 0) as month,
    coalesce(sum(l.hours) filter (where ${inR.sql}), 0) as range,
    coalesce(sum(l.hours), 0) as all`, [d.today, d.yesterday, ...d.week, ...d.month, ...inR.args]));
}

/**
 * Allocation vs taken per member on their active projects (Running / On hold / Planning),
 * restricted to `projectIds` (null = all): allocated hours, hours taken (all time), project count, running?
 */
export async function allocation(memberIds, projectIds) {
  if (!memberIds.length) return [];
  const b = db('project_members as pm').join('projects as p', 'p.id', 'pm.project_id').whereIn('pm.member_id', memberIds);
  if (projectIds) b.whereIn('p.id', projectIds.length ? projectIds : ['__none__']);
  return b.groupBy('pm.member_id').select('pm.member_id', db.raw(`
    coalesce(sum(pm.alloc_hours) filter (where p.status in ('Running','On hold','Planning')), 0) as allocated,
    coalesce(sum((select sum(l.hours) from time_logs l where l.project_id = pm.project_id and l.member_id = pm.member_id))
      filter (where p.status in ('Running','On hold','Planning')), 0) as taken,
    (count(*) filter (where p.status in ('Running','On hold','Planning')))::int as projects,
    bool_or(p.status = 'Running') as running`));
}
