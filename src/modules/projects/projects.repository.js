/** Knex queries for projects, milestones, members, links, logs and portal lookups. */
import { db } from '../../db/knex.js';
import { restrictTo } from '../../core/scope.js';
import { toProject, toMilestone, toMember, toLog } from './projects.mapper.js';

const PROJECT_COLS = ['id', 'name', 'client', 'services', 'status', 'pm_member_id', 'start_date', 'due_date', 'value', 'hue', 'priority', 'brief',
  'portal_on', 'portal_token', 'created_at', 'updated_at'];

/** Projects (optionally limited to `ids`) with team + links attached. */
export async function findProjects(ids, q = db) {
  const rows = await restrictTo(q('projects').select(PROJECT_COLS), 'id', ids).orderBy('id');
  return attachTeamAndLinks(rows, q);
}

export async function findProject(id, q = db) {
  const row = await q('projects').where({ id }).first(PROJECT_COLS);
  if (!row) return null;
  return (await attachTeamAndLinks([row], q))[0];
}

/** Lock a project row inside a transaction (serialises concurrent CR approvals, n numbering …). */
export const lockProject = (trx, id) => trx('projects').where({ id }).forUpdate().first('id');

async function attachTeamAndLinks(rows, q) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [team, links] = await Promise.all([
    q('project_members').whereIn('project_id', ids).orderBy(['project_id', 'position', 'member_id']),
    q('project_links').whereIn('project_id', ids).orderBy('id'),
  ]);
  return rows.map((r) => toProject(r, team.filter((t) => t.project_id === r.id), links.filter((l) => l.project_id === r.id)));
}

export async function findMilestones(projectIds, q = db) {
  const rows = await restrictTo(q('milestones'), 'project_id', projectIds).orderBy(['project_id', 'n']);
  return rows.map(toMilestone);
}

export async function findMilestone(id, q = db) {
  const r = await q('milestones').where({ id }).first();
  return r ? toMilestone(r) : null;
}

export async function findMembers(q = db) {
  return (await q('members').orderBy('name')).map(toMember);
}

/** Time logs of the given projects (all when null). */
export async function findLogs(projectIds, q = db) {
  const rows = await restrictTo(q('time_logs').select('id', 'member_id', 'project_id', 'milestone_id', 'day', 'hours', 'note', 'source', 'created_at'), 'project_id', projectIds)
    .orderBy([{ column: 'day', order: 'desc' }, { column: 'created_at', order: 'desc' }]);
  return rows.map(toLog);
}

/** Per-project counts used by the health score: blocked tasks and open critical bugs. */
export async function healthCounts(projectIds, q = db) {
  const [blk, crit] = await Promise.all([
    restrictTo(q('tasks').where({ status: 'Blocked' }), 'project_id', projectIds).groupBy('project_id').select('project_id').count('* as n'),
    restrictTo(q('bugs').where({ severity: 'Critical' }).whereNotIn('status', ['Closed', 'Fixed']), 'project_id', projectIds)
      .groupBy('project_id').select('project_id').count('* as n'),
  ]);
  const map = (rows) => Object.fromEntries(rows.map((r) => [r.project_id, Number(r.n)]));
  return { blocked: map(blk), critical: map(crit) };
}

export async function findOpenTasks(projectIds, q = db) {
  const rows = await restrictTo(q('tasks').whereNot({ status: 'Done' }), 'project_id', projectIds)
    .select('id', 'project_id', 'assignee_id', 'status', 'due_date', 'estimate_hours');
  return rows.map((t) => ({ id: t.id, projectId: t.project_id, assigneeId: t.assignee_id, status: t.status, dueDate: t.due_date, estimateHours: Number(t.estimate_hours) }));
}

export const findDocuments = (entityType, entityId, q = db) => q('documents').where({ entity_type: entityType, entity_id: entityId }).orderBy('created_at', 'desc');

export const findProjectByToken = (token, q = db) => q('projects').where({ portal_token: token, portal_on: true }).first('id');

/** Currency setting (INR default) used in money labels. */
export async function currency(q = db) {
  const r = await q('settings').where({ key: 'currency' }).first('value');
  const v = r && r.value;
  return v === 'USD' ? 'USD' : 'INR';
}
