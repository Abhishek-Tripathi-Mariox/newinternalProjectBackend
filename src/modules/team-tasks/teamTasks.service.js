/**
 * Team tasks — independent of projects. Rights come from the role's `tt` (Team tasks) permission:
 * - scope All: sees every task and can give tasks to anyone.
 * - scope Team: sees tasks assigned to / created by them and tasks of people below them in
 *   "Reports to" (direct or indirect); gives tasks to themself or those people.
 * - scope Own: only tasks assigned to / created by them; gives tasks to themself only.
 * Create = give tasks. A task's managers (creator, someone above the assignee, scope All) edit it
 * with Edit and delete it with Delete. The assignee can always change status, write a progress
 * note and add their own files.
 */
import { db } from '../../db/knex.js';
import { nextId } from '../../core/ids.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import { reporteesOf } from '../../middleware/authenticate.js';
import { sendMail, mailEnabled } from '../../core/mailer.js';
import { layout, esc } from '../../core/emailLayout.js';
import { config } from '../../config/index.js';
import { logger } from '../../core/logger.js';
import { peopleScope, visibleProjectIds } from '../../core/scope.js';
import { documentsService } from '../documents/documents.service.js';

const FULL = { v: true, c: true, e: true, d: true, scope: 'all' };
/** The user's Team tasks permission ({v,c,e,d,scope}); Super Admin = everything. */
export const ttPerm = (user) => (user.isSuper ? FULL : ((user.role.perms || {}).tt || { v: false, c: false, e: false, d: false, scope: 'own' }));
const isBoss = (user) => ttPerm(user).scope === 'all';

/** Ids of the people `user` manages (below them in "Reports to"); none with scope Own. */
const teamIds = async (user) => (ttPerm(user).scope === 'own' ? [] : (user.reportees || (await reporteesOf(user.id))).map((r) => r.id));

const baseQuery = (q = db) => q('team_tasks as t')
  .join('users as a', 'a.id', 't.assignee_id')
  .leftJoin('users as c', 'c.id', 't.created_by')
  .leftJoin('projects as p', 'p.id', 't.project_id')
  .leftJoin('leads as l', 'l.id', 't.lead_id')
  .select('t.*', 'a.name as assignee_name', 'c.name as creator_name', 'p.name as project_name', 'l.company as lead_company', 'l.contact as lead_contact');

const iso = (v) => (v ? new Date(v).toISOString() : null);
const day = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Estimated hours: '' / null / 0 → not set. */
const estValue = (v) => (v === '' || v == null || !(+v > 0) ? null : Math.round(+v * 100) / 100);

/** Adds uploaderName to each attachment (who added the file). */
async function withUploaders(docs) {
  const all = [].concat(...Object.values(docs));
  const ids = [...new Set(all.map((d) => d.uploadedBy).filter(Boolean))];
  if (!ids.length) return docs;
  const names = Object.fromEntries((await db('users').whereIn('id', ids).select('id', 'name')).map((u) => [u.id, u.name]));
  all.forEach((d) => { d.uploaderName = names[d.uploadedBy] || null; });
  return docs;
}

function toDto(r, user, team, attachments) {
  const manager = isBoss(user) || r.created_by === user.id || team.includes(r.assignee_id);
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    priority: r.priority,
    status: r.status,
    dueDate: day(r.due_date),
    estimateHours: r.estimate_hours == null ? null : Number(r.estimate_hours),
    projectId: r.project_id || null,
    projectName: r.project_name || null,
    leadId: r.lead_id || null,
    leadName: r.lead_id ? (r.lead_company || r.lead_contact || r.lead_id) : null,
    assigneeId: r.assignee_id,
    assigneeName: r.assignee_name,
    createdBy: r.created_by,
    creatorName: r.creator_name || null,
    updateNote: r.update_note,
    doneAt: iso(r.done_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    canEdit: manager && !!ttPerm(user).e,
    canDelete: manager && !!ttPerm(user).d,
    canUpdateStatus: (manager && !!ttPerm(user).e) || r.assignee_id === user.id,
    attachments: attachments || [],
  };
}

function scoped(q, user, team) {
  if (isBoss(user)) return q;
  return q.where((w) => w.where('t.assignee_id', user.id).orWhere('t.created_by', user.id).orWhereIn('t.assignee_id', team.length ? team : ['__none__']));
}

export async function list(query, user) {
  const team = await teamIds(user);
  const p = pageParams(query, { defaultSize: 500, maxSize: 1000 });
  const rows = await scoped(baseQuery(), user, team).orderBy('t.created_at', 'desc').limit(p.limit).offset(p.offset);
  const [{ n }] = await scoped(db('team_tasks as t'), user, team).count({ n: '*' });
  const docs = await withUploaders(await documentsService.listForMany('team_task', rows.map((r) => r.id)));
  return { items: rows.map((r) => toDto(r, user, team, docs[r.id])), meta: p.meta(Number(n)) };
}

async function readable(id, user, q = db) {
  const team = await teamIds(user);
  const row = await scoped(baseQuery(q), user, team).where('t.id', id).first();
  if (!row) throw notFound('Task');
  return { row, team };
}

export async function get(id, user) {
  const { row, team } = await readable(id, user);
  const docs = await withUploaders({ [id]: await documentsService.listFor('team_task', id) });
  return toDto(row, user, team, docs[id]);
}

/** For document downloads / removal: null when the user can't see the task, else its rights. */
export async function taskAccess(id, user) {
  try {
    const { row, team } = await readable(id, user);
    const d = toDto(row, user, team);
    return { canEdit: d.canEdit, canUpdateStatus: d.canUpdateStatus };
  } catch {
    return null;
  }
}

/** Upload files to a task (multipart "files"): the assignee, whoever gave it, or a manager above the assignee. */
export async function addAttachments(id, files, user, title = '') {
  try {
    const { row, team } = await readable(id, user);
    if (!toDto(row, user, team).canUpdateStatus) throw forbidden('Only the assignee, the person who gave this task or their manager can add files to it.');
    if (!files || !files.length) throw unprocessable('Pick at least one file.');
    if (String(title || '').length > 200) throw unprocessable('Keep the file title under 200 characters.');
    await documentsService.attach('team_task', id, files, user, db, { title });
  } catch (e) {
    await documentsService.discard(files);
    throw e;
  }
  return get(id, user);
}

/** People this user may give a task to: themself + their reportees (everyone for Super Admin / Admin). */
export async function assignees(user) {
  if (!ttPerm(user).c) return [];
  if (isBoss(user)) {
    const rows = await db('users as u').join('roles as r', 'r.id', 'u.role_id').where('u.status', 'Active').whereNot('u.role_id', 'r-client')
      .orderBy('u.name').select('u.id', 'u.name', 'r.name as role');
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, self: r.id === user.id }));
  }
  const team = ttPerm(user).scope === 'own' ? [] : user.reportees || (await reporteesOf(user.id));
  return [{ id: user.id, name: user.name, role: user.role.name, self: true }].concat(team.map((r) => ({ id: r.id, name: r.name, role: r.role, self: false })));
}

async function checkAssignee(user, assigneeId, q = db) {
  const u = await q('users').where({ id: assigneeId }).first('id', 'name', 'email', 'status', 'role_id');
  if (!u || u.status !== 'Active' || u.role_id === 'r-client') throw unprocessable('Pick who this task is for.');
  if (assigneeId === user.id || isBoss(user)) return u;
  if (!(await teamIds(user)).includes(assigneeId)) throw forbidden(ttPerm(user).scope === 'own' ? 'Your role can only add tasks for yourself.' : 'You can only give tasks to yourself or people who report to you.');
  return u;
}

const dueValue = (v) => (v ? v : null);

/** Optional lead link: must be a lead the person giving the task can see (Leads view + scope). */
async function leadValue(user, id, q = db) {
  if (!id) return null;
  const lv = user.isSuper || !!(((user.role.perms || {}).leads || {}).v);
  const l = await q('leads').where({ id }).first('id', 'owner_id');
  if (!lv || !l) throw unprocessable('Pick a lead you can see.');
  const { people } = await peopleScope(user, 'leads');
  if (people && !people.includes(l.owner_id)) throw unprocessable('Pick a lead you can see.');
  return id;
}

/** Optional project link: must be a project the person giving the task can see. */
async function projectValue(user, id, q = db) {
  if (!id) return null;
  const ids = await visibleProjectIds(user);
  const p = await q('projects').where({ id }).first('id');
  if (!p || (ids && !ids.includes(id))) throw unprocessable('Pick a project you can see.');
  return id;
}

function notify(assignee, task, by) {
  if (!mailEnabled() || !assignee.email || assignee.id === by.id) return;
  const link = `${config.appUrl}/team-tasks`;
  const body = `<p><b>${esc(task.title)}</b>${task.projectName ? ` · ${esc(task.projectName)}` : ''}${task.leadName ? ` · Lead: ${esc(task.leadName)}` : ''}</p>${task.notes ? `<p style="white-space:pre-wrap">${esc(task.notes)}</p>` : ''}`
    + `<p>Priority: ${esc(task.priority)}${task.dueDate ? ` · Due: ${esc(task.dueDate)}` : ''}${task.estimateHours ? ` · Estimate: ${task.estimateHours}h` : ''}</p>`;
  sendMail({
    to: assignee.email,
    subject: `New task from ${by.name}: ${task.title}`,
    text: `${by.name} gave you a task: ${task.title}\n${task.notes || ''}\n${link}`,
    html: layout({ heading: 'You have a new task', intro: `${esc(by.name)} gave you a task.`, body, button: 'Open my tasks', link, footer: 'Mariox portal · Team tasks' }),
  }).catch((e) => logger.warn({ err: e }, 'team task email failed'));
}

export async function create(b, user) {
  const { id, assignee } = await db.transaction(async (trx) => {
    if (!ttPerm(user).c) throw forbidden('Your role can’t give tasks.');
    const a = await checkAssignee(user, b.assigneeId, trx);
    const tid = await nextId(trx, 'teamTask');
    const status = b.status || 'To do';
    await trx('team_tasks').insert({
      id: tid,
      title: b.title.trim(),
      notes: b.notes || '',
      priority: b.priority || 'Medium',
      status,
      due_date: dueValue(b.dueDate),
      estimate_hours: estValue(b.estimateHours),
      project_id: await projectValue(user, b.projectId, trx),
      lead_id: await leadValue(user, b.leadId, trx),
      assignee_id: a.id,
      created_by: user.id,
      done_at: status === 'Done' ? new Date() : null,
    });
    return { id: tid, assignee: a };
  });
  const dto = await get(id, user);
  notify(assignee, dto, user);
  return dto;
}

export async function update(id, b, user) {
  let reassigned = null;
  await db.transaction(async (trx) => {
    const { row, team } = await readable(id, user, trx);
    const dto = toDto(row, user, team);
    const managerFields = ['title', 'notes', 'priority', 'dueDate', 'estimateHours', 'assigneeId', 'projectId', 'leadId'].filter((k) => b[k] !== undefined);
    if (managerFields.length && !dto.canEdit) throw forbidden('Only the person who gave this task (or their manager) can change it — you can update its status and progress note.');
    if ((b.status !== undefined || b.updateNote !== undefined) && !dto.canUpdateStatus) throw forbidden('You can’t update this task.');
    const patch = {};
    if (b.title !== undefined) patch.title = b.title.trim();
    if (b.notes !== undefined) patch.notes = b.notes;
    if (b.priority !== undefined) patch.priority = b.priority;
    if (b.dueDate !== undefined) patch.due_date = dueValue(b.dueDate);
    if (b.estimateHours !== undefined) patch.estimate_hours = estValue(b.estimateHours);
    if (b.updateNote !== undefined) patch.update_note = b.updateNote;
    if (b.projectId !== undefined && (b.projectId || null) !== row.project_id) patch.project_id = await projectValue(user, b.projectId, trx);
    if (b.leadId !== undefined && (b.leadId || null) !== row.lead_id) patch.lead_id = await leadValue(user, b.leadId, trx);
    if (b.assigneeId !== undefined && b.assigneeId !== row.assignee_id) {
      reassigned = await checkAssignee(user, b.assigneeId, trx);
      patch.assignee_id = reassigned.id;
    }
    if (b.status !== undefined && b.status !== row.status) {
      patch.status = b.status;
      patch.done_at = b.status === 'Done' ? new Date() : null;
    }
    if (Object.keys(patch).length) await trx('team_tasks').where({ id }).update(patch);
  });
  const dto = await get(id, user).catch(() => null);
  if (reassigned && dto) notify(reassigned, dto, user);
  // Reassigned away from someone outside your view: return a minimal stub.
  return dto || { id, removed: true };
}

export async function remove(id, user) {
  await db.transaction(async (trx) => {
    const { row, team } = await readable(id, user, trx);
    if (!toDto(row, user, team).canDelete) throw forbidden('Only the person who gave this task (or their manager) can delete it.');
    const cleanup = await documentsService.removeForEntity('team_task', id, trx);
    await trx('team_tasks').where({ id }).del();
    return cleanup;
  }).then((cleanup) => cleanup());
}
