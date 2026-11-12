import { db } from '../../db/knex.js';

/** Current milestone of a project: first not-Done by n, else the last; null if none (frontend curMs). */
export async function curMs(q, projectId) {
  const ms = await q('milestones').where({ project_id: projectId }).orderBy('n').select('id', 'status');
  return ((ms.find((m) => m.status !== 'Done') || ms[ms.length - 1]) || {}).id || null;
}

export const findMilestone = (q, id) => q('milestones').where({ id }).first('id', 'project_id');
export const findMember = (q, id) => q('members').where({ id }).first('id', 'name', 'team');
export const findProject = (q, id) => q('projects').where({ id }).first('id', 'name');

const PRIO_RANK = "(case t.priority when 'High' then 0 when 'Medium' then 1 else 2 end)";
const STATUS_RANK = "(case t.status when 'To do' then 0 when 'In progress' then 1 when 'Blocked' then 2 when 'In review' then 3 else 4 end)";
export const TASK_SORTS = {
  due: 't.due_date', priority: PRIO_RANK, status: STATUS_RANK, created: 't.created_at', updated: 't.updated_at', title: 't.title', id: 't.id',
};

const COLS = ['t.*', 'p.name as project_name', 'm.name as milestone_name', 'm.n as milestone_n', 'a.name as assignee_name', 'a.team as assignee_team'];

/** Base query with joins + row scope ({ projectIds, people } — null = unrestricted). */
export function scoped(scope, q = db) {
  const b = q('tasks as t')
    .join('projects as p', 'p.id', 't.project_id')
    .leftJoin('milestones as m', 'm.id', 't.milestone_id')
    .leftJoin('members as a', 'a.id', 't.assignee_id');
  if (scope.projectIds) b.whereIn('t.project_id', scope.projectIds.length ? scope.projectIds : ['__none__']);
  if (scope.people) b.whereIn('t.assignee_id', scope.people.length ? scope.people : ['__none__']);
  return b;
}

export const getById = (scope, id, q = db) => scoped(scope, q).where('t.id', id).first(COLS);

/** Filters from the list query (chips use today / end of this week). */
export function applyFilters(b, f, { today, weekEnd }) {
  if (f.project) b.where('t.project_id', f.project);
  if (f.milestone) b.where('t.milestone_id', f.milestone);
  if (f.assignee) b.where('t.assignee_id', f.assignee);
  if (f.team) b.where('a.team', f.team);
  if (f.status) b.where('t.status', f.status);
  if (f.priority) b.where('t.priority', f.priority);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    b.where((w) => w.whereILike('t.title', like).orWhereILike('p.name', like).orWhereILike('a.name', like).orWhereILike('t.id', like));
  }
  switch (f.chip) {
    case 'overdue': b.whereNot('t.status', 'Done').where('t.due_date', '<', today); break;
    case 'week': b.whereNot('t.status', 'Done').where('t.due_date', '>=', today).where('t.due_date', '<', weekEnd); break;
    case 'high': b.whereNot('t.status', 'Done').where('t.priority', 'High'); break;
    case 'blocked': b.where('t.status', 'Blocked'); break;
    case 'unassigned': b.whereNull('t.assignee_id'); break;
    default: break;
  }
  return b;
}

export async function list(scope, f, ctx, sort, page) {
  const base = applyFilters(scoped(scope), f, ctx);
  const [{ count }] = await base.clone().clearSelect().count('* as count');
  const rows = base.clone().select(COLS).limit(page.limit).offset(page.offset);
  if (sort) rows.orderByRaw(`${sort[0]} ${sort[1]} nulls last`).orderBy('t.id');
  else rows.orderByRaw(`${STATUS_RANK}, ${PRIO_RANK}, t.due_date asc nulls last, t.id`); // frontend list: status, then taskSort
  return { rows: await rows, total: Number(count) };
}

/** Counts for the chips + summary line, over the same filters (no chip). */
export async function counts(scope, f, { today, weekEnd }) {
  const b = applyFilters(scoped(scope), { ...f, chip: undefined }, { today, weekEnd });
  const [r] = await b.select(db.raw(`
    count(*)::int as all,
    count(*) filter (where t.status <> 'Done')::int as open,
    count(*) filter (where t.status = 'Done')::int as done,
    count(*) filter (where t.status <> 'Done' and t.due_date < ?)::int as overdue,
    count(*) filter (where t.status <> 'Done' and t.due_date >= ? and t.due_date < ?)::int as week,
    count(*) filter (where t.status <> 'Done' and t.priority = 'High')::int as high,
    count(*) filter (where t.status = 'Blocked')::int as blocked,
    count(*) filter (where t.assignee_id is null)::int as unassigned`, [today, today, weekEnd]));
  return r;
}

export const insert = (q, row) => q('tasks').insert(row);
export const update = (q, id, patch) => q('tasks').where({ id }).update(patch);
export const remove = (q, id) => q('tasks').where({ id }).del();
