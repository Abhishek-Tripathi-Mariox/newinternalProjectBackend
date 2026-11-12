import { db } from '../../db/knex.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { nextId } from '../../core/ids.js';
import { pageParams, sortParam } from '../../core/http.js';
import { peopleScope, visibleProjectIds } from '../../core/scope.js';
import { today, weekOf } from '../timesheets/period.js';
import * as repo from './tasks.repository.js';
import { toRow, toTask } from './tasks.mapper.js';

/**
 * Row scope for tasks (frontend scopeState): visible projects AND assignee within the user's
 * tasks scope (own → themselves, team → their delivery team, all → anyone).
 */
export async function taskScope(user) {
  const [projectIds, ps] = await Promise.all([visibleProjectIds(user), peopleScope(user, 'tasks')]);
  return { projectIds, people: ps.people };
}

/** Writes must leave the task inside the writer's scope (no assigning work outside your team). */
function assertWritable(scope, t) {
  if (scope.projectIds && !scope.projectIds.includes(t.project_id)) throw forbidden("You don't have access to this project");
  if (scope.people && !(t.assignee_id && scope.people.includes(t.assignee_id))) {
    throw forbidden('You can only assign tasks to people in your scope');
  }
}

/** Milestone must belong to the project; assignee must exist. */
async function checkRefs(q, row) {
  if (!(await repo.findProject(q, row.project_id))) throw unprocessable('Pick a project.');
  if (row.milestone_id) {
    const ms = await repo.findMilestone(q, row.milestone_id);
    if (!ms || ms.project_id !== row.project_id) throw unprocessable('Pick a milestone of this project.');
  }
  if (row.assignee_id && !(await repo.findMember(q, row.assignee_id))) throw unprocessable('Assignee not found.');
}

const chipCtx = () => ({ today: today(), weekEnd: weekOf()[1] });

export async function list(user, query) {
  const scope = await taskScope(user);
  const page = pageParams(query);
  const sort = sortParam(query.sort, repo.TASK_SORTS, null);
  const ctx = chipCtx();
  const [{ rows, total }, c] = await Promise.all([repo.list(scope, query, ctx, sort, page), repo.counts(scope, query, ctx)]);
  return {
    data: rows.map(toTask),
    meta: { ...page.meta(total), counts: c, summary: `${c.open} open · ${c.overdue} overdue · ${c.done} done` },
  };
}

export async function get(user, id) {
  const row = await repo.getById(await taskScope(user), id);
  if (!row) throw notFound('Task');
  return toTask(row);
}

/** saveTask (create): "Add a task title."; milestone defaults to the project's current milestone. */
export async function create(user, body) {
  const title = (body.title || '').trim();
  if (!title) throw unprocessable('Add a task title.');
  const scope = await taskScope(user);
  return db.transaction(async (trx) => {
    const row = toRow({ ...body, title });
    if (body.milestoneId === undefined || body.milestoneId === null) row.milestone_id = await repo.curMs(trx, body.projectId);
    // Own / team scoped creators default to assigning themselves (an unassigned task would vanish from their board).
    if (body.assigneeId === undefined) row.assignee_id = scope.people ? user.memberId || null : null;
    assertWritable(scope, row);
    await checkRefs(trx, row);
    row.id = await nextId(trx, 'task');
    row.log = JSON.stringify([]);
    await repo.insert(trx, row);
    return toTask(await repo.getById({}, row.id, trx));
  });
}

/** saveTask (edit) / updTask: any subset of fields; a status change appends "Status → X" to the task log. */
export async function update(user, id, body) {
  if (body.title !== undefined && !body.title.trim()) throw unprocessable('Add a task title.');
  const scope = await taskScope(user);
  return db.transaction(async (trx) => {
    const old = await repo.getById(scope, id, trx).forUpdate('t');
    if (!old) throw notFound('Task');
    const patch = toRow({ ...body, ...(body.title !== undefined ? { title: body.title.trim() } : {}) });
    // Moving to another project without a milestone → that project's current milestone.
    if (body.projectId && body.projectId !== old.project_id && body.milestoneId === undefined) {
      patch.milestone_id = await repo.curMs(trx, body.projectId);
    }
    const next = { ...old, ...patch };
    assertWritable(scope, next);
    await checkRefs(trx, next);
    if (body.status && body.status !== old.status) {
      patch.log = JSON.stringify((old.log || []).concat({ d: new Date().toISOString(), t: `Status → ${body.status}` }));
    }
    if (Object.keys(patch).length) await repo.update(trx, id, patch);
    return toTask(await repo.getById({}, id, trx));
  });
}

/** Replace the checklist (blank items dropped). */
export async function setChecklist(user, id, items) {
  const scope = await taskScope(user);
  const row = await repo.getById(scope, id);
  if (!row) throw notFound('Task');
  const cl = items.map((x) => ({ t: x.t.trim(), done: !!x.done })).filter((x) => x.t);
  await repo.update(db, id, { checklist: JSON.stringify(cl) });
  return toTask(await repo.getById({}, id));
}

export async function remove(user, id) {
  const row = await repo.getById(await taskScope(user), id);
  if (!row) throw notFound('Task');
  await repo.remove(db, id);
}
