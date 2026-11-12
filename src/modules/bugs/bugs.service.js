import { db } from '../../db/knex.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { nextId } from '../../core/ids.js';
import { pageParams, sortParam } from '../../core/http.js';
import { peopleScope, visibleProjectIds } from '../../core/scope.js';
import { can } from '../../middleware/authorize.js';
import { documentsService, toDocument } from '../documents/documents.service.js';
import { addDays, range, today } from '../timesheets/period.js';
import { curMs, findMember, findMilestone } from '../tasks/tasks.repository.js';
import * as repo from './bugs.repository.js';
import { toBug, toEvent, toRow } from './bugs.mapper.js';
import { SEVERITY_DAYS } from './bugs.schemas.js';

const isClient = (user) => user.role.id === 'r-client';
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

/**
 * Row scope for bugs (frontend scopeState): visible projects AND (client → every bug of their
 * projects | scope all | assignee within scope | reported by the user).
 */
export async function bugScope(user) {
  const projectIds = await visibleProjectIds(user);
  if (isClient(user)) return { projectIds, people: null, pid: user.pid };
  const { people, pid } = await peopleScope(user, 'bugs');
  return { projectIds, people, pid };
}

/** Display name for a reporter / assignee id (frontend MEMn). */
async function nameOf(q, id, user) {
  if (id === 'client') return 'Client';
  if (!id) return 'Unassigned';
  const m = await findMember(q, id);
  if (m) return m.name;
  return user && id === user.pid ? user.name : 'Unassigned';
}

const assertProject = (scope, projectId) => {
  if (scope.projectIds && !scope.projectIds.includes(projectId)) throw forbidden("You don't have access to this project");
};

async function checkRefs(q, row) {
  if (row.milestone_id) {
    const ms = await findMilestone(q, row.milestone_id);
    if (!ms || ms.project_id !== row.project_id) throw unprocessable('Pick a milestone of this project.');
  }
  if (row.assignee_id && !(await findMember(q, row.assignee_id))) throw unprocessable('Assignee not found.');
}

/** ?include=events,attachments → embed those arrays (one query each for the page). */
async function embed(bugs, include = []) {
  if (!include.length || !bugs.length) return bugs;
  const ids = bugs.map((b) => b.id);
  const [events, atts] = await Promise.all([
    include.includes('events') ? repo.eventsOfMany(ids) : null,
    include.includes('attachments') ? documentsService.listForMany('bug', ids) : null,
  ]);
  const evOf = {};
  (events || []).forEach((e) => (evOf[e.bug_id] ||= []).push(toEvent(e)));
  return bugs.map((b) => ({
    ...b,
    ...(events && { events: evOf[b.id] || [] }),
    ...(atts && { attachments: atts[b.id] }),
  }));
}

export async function list(user, f) {
  const scope = await bugScope(user);
  const page = pageParams(f);
  const sort = sortParam(f.sort, repo.BUG_SORTS, null);
  const rg = f.allTime ? null : range(f.date || 'month', f.from, f.to);
  const T = today();
  const [{ rows, total }, kpis] = await Promise.all([repo.list(scope, f, rg, T, sort, page), repo.kpis(scope, f, rg, T)]);
  return { data: await embed(rows.map(toBug), f.include), meta: { ...page.meta(total), kpis } };
}

async function loadDetail(scope, id, q = db) {
  const row = await repo.getById(scope, id, q);
  if (!row) throw notFound('Bug');
  const [events, atts] = await Promise.all([repo.events(id, q), repo.attachments(id, q)]);
  return { ...toBug(row), events: events.map(toEvent), attachments: atts.map(toDocument) };
}

export async function get(user, id) {
  return loadDetail(await bugScope(user), id);
}

/**
 * saveBug (create). Defaults like the bug modal: milestone = current milestone, due date from the
 * severity (Critical 1 / Major 3 / Minor 7 / Trivial 14 days after the report date), Critical →
 * High priority, and the department auto-assigns the first project member of that team when no
 * one is assigned. History: "Reported by X" (+ "Assigned to Y").
 */
export async function create(user, body) {
  const title = (body.title || '').trim();
  if (!title) throw unprocessable('Add a short bug title.');
  const scope = await bugScope(user);
  assertProject(scope, body.projectId);
  const client = isClient(user);

  return db.transaction(async (trx) => {
    const row = toRow({ ...body, title });
    if (client) {
      // Clients only describe the problem; the team triages it.
      row.reporter = 'client';
      row.status = 'Open';
      row.reported_on = today();
      delete row.assignee_id;
    } else if (scope.people || !body.reporter) {
      // Own / team scoped users always report as themselves.
      row.reporter = user.memberId || user.pid;
    }
    if (row.reporter !== 'client' && row.reporter !== user.pid && !(await findMember(trx, row.reporter))) throw unprocessable('Reporter not found.');
    row.reported_on = row.reported_on || today();
    row.priority = body.priority || 'High'; // bug modal default; Critical always means High
    if (body.dueDate === undefined) row.due_date = addDays(row.reported_on, SEVERITY_DAYS[row.severity]);
    if (!row.milestone_id) row.milestone_id = await curMs(trx, row.project_id);
    if (!row.assignee_id) row.assignee_id = ((await repo.firstOfTeam(trx, row.project_id, row.dept)) || {}).id || null;
    await checkRefs(trx, row);

    row.id = await nextId(trx, 'bug');
    await trx('bugs').insert(row);
    const ev = [`Reported by ${await nameOf(trx, row.reporter, user)}`];
    if (row.assignee_id) ev.push(`Assigned to ${await nameOf(trx, row.assignee_id)}`);
    await repo.addEvents(trx, row.id, ev, user.id);
    return loadDetail({}, row.id, trx);
  });
}

/**
 * saveBug (edit) / updBug. History lines exactly like the frontend: "Status → X",
 * "Assigned to Y", "Severity → Z", "Removed N attachment(s)".
 */
export async function update(user, id, body) {
  if (body.title !== undefined && !body.title.trim()) throw unprocessable('Add a short bug title.');
  const scope = await bugScope(user);
  let unlink = [];
  const out = await db.transaction(async (trx) => {
    const old = await repo.getById(scope, id, trx);
    if (!old) throw notFound('Bug');
    await trx('bugs').where({ id }).forUpdate().first('id');
    const patch = toRow({ ...body, ...(body.title !== undefined ? { title: body.title.trim() } : {}) });
    if (patch.project_id && patch.project_id !== old.project_id) {
      assertProject(scope, patch.project_id);
      if (body.milestoneId === undefined) patch.milestone_id = await curMs(trx, patch.project_id);
    }
    if (patch.reporter && patch.reporter !== old.reporter) {
      if (scope.people) throw forbidden('You can only report bugs as yourself');
      if (patch.reporter !== 'client' && !(await findMember(trx, patch.reporter))) throw unprocessable('Reporter not found.');
    }
    if (patch.severity === 'Critical' && patch.severity !== old.severity && !body.priority) patch.priority = 'High';
    const next = { ...old, ...patch };
    await checkRefs(trx, next);

    const notes = [];
    if (patch.status !== undefined && patch.status !== old.status) notes.push(`Status → ${patch.status}`);
    if (patch.assignee_id !== undefined && patch.assignee_id !== old.assignee_id) notes.push(`Assigned to ${await nameOf(trx, patch.assignee_id)}`);
    if (patch.severity !== undefined && patch.severity !== old.severity) notes.push(`Severity → ${patch.severity}`);
    if (body.removeAttachmentIds && body.removeAttachmentIds.length) {
      const gone = await trx('documents').where({ entity_type: 'bug', entity_id: id }).whereIn('id', body.removeAttachmentIds).del().returning('storage_path');
      if (gone.length) notes.push(`Removed ${plural(gone.length, 'attachment')}`);
      unlink = gone.map((g) => g.storage_path).filter(Boolean);
    }
    if (Object.keys(patch).length) await trx('bugs').where({ id }).update(patch);
    await repo.addEvents(trx, id, notes, user.id);
    return loadDetail({}, id, trx);
  });
  await documentsService.removeObjects(unlink);
  return out;
}

/** Comment from the bug modal → history "Comment: …". */
export async function comment(user, id, text) {
  const t = (text || '').trim();
  if (!t) throw unprocessable('Write a comment first.');
  const scope = await bugScope(user);
  if (!(await repo.getById(scope, id))) throw notFound('Bug');
  await repo.addEvents(db, id, [`Comment: ${t}`], user.id);
  return loadDetail(scope, id);
}

/**
 * Upload attachments (multipart field "files"). Allowed with bugs 'e', or with bugs 'c' on a bug the
 * user reported themselves (so clients can add screenshots to their own reports). History "Added N attachment(s)".
 */
export async function addAttachments(user, id, files) {
  try {
    const scope = await bugScope(user);
    if (!(await repo.getById(scope, id))) throw notFound('Bug');
    if (!can(user, 'bugs', 'e')) {
      const first = await repo.firstActor(id);
      if (!can(user, 'bugs', 'c') || !first || first.actor_user_id !== user.id) throw forbidden("You can only add files to bugs you reported");
    }
    if (!files || !files.length) throw unprocessable('Pick at least one file.');
    return await db.transaction(async (trx) => {
      await documentsService.attach('bug', id, files, user, trx);
      await repo.addEvents(trx, id, [`Added ${plural(files.length, 'attachment')}`], user.id);
      return loadDetail({}, id, trx);
    });
  } catch (e) {
    await documentsService.discard(files);
    throw e;
  }
}

export async function remove(user, id) {
  const scope = await bugScope(user);
  if (!(await repo.getById(scope, id))) throw notFound('Bug');
  const cleanup = await db.transaction(async (trx) => {
    const fn = await documentsService.removeForEntity('bug', id, trx);
    await trx('bugs').where({ id }).del();
    return fn;
  });
  await cleanup();
}
