/**
 * Project follow-ups — meetings, calls, tasks and reminders on a project. Anyone who can see the
 * project (the `projects` module scope) can add, edit and complete them; deleting is limited to the
 * person who created it, its owner, and the project's PM / Super Admin.
 */
import { db } from '../../db/knex.js';
import { nextId } from '../../core/ids.js';
import { visibleProjectIds, restrictTo } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import { DAY, parseDay, sod } from '../leads/leads.util.js';
import { FU_DEFAULTS } from '../followups/followups.schemas.js';
import { isPMof } from '../projects/projects.service.js';
import * as prepo from '../projects/projects.repository.js';
import { toProjectFollowUp } from './projectFollowups.mapper.js';

const baseQuery = (q = db) => q('project_follow_ups as f')
  .join('projects as p', 'p.id', 'f.project_id')
  .leftJoin('members as m', 'm.id', 'f.owner_member_id')
  .select('f.*', 'p.name as project_name', 'p.client as project_client', 'm.name as owner_name');

function applyFilters(q, f) {
  if (f.projectId) q.where('f.project_id', f.projectId);
  if (f.owner) q.where('f.owner_member_id', f.owner);
  if (f.type) q.where('f.type', f.type);
  if (f.priority) q.where('f.priority', f.priority);
  if (f.from) q.where('f.due_at', '>=', new Date(parseDay(f.from)));
  if (f.to) q.where('f.due_at', '<', new Date(parseDay(f.to) + DAY));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    q.where((w) => w.whereILike('f.title', like).orWhereILike('p.name', like).orWhereILike('p.client', like));
  }
  return q;
}

function applyTab(q, tab, now) {
  const T = sod(now);
  switch (tab) {
    case 'today': return q.where('f.done', false).where('f.due_at', '>=', new Date(T)).where('f.due_at', '<', new Date(T + DAY));
    case 'upcoming': return q.where('f.done', false).where('f.due_at', '>=', new Date(T + DAY));
    case 'overdue': return q.where('f.done', false).where('f.due_at', '<', new Date(now));
    case 'completed': return q.where('f.done', true);
    default: return q;
  }
}

export async function list(query, user) {
  const now = Date.now();
  const T = sod(now);
  const ids = await visibleProjectIds(user);
  const p = pageParams(query, { defaultSize: 100, maxSize: 500 });
  const rows = await applyTab(applyFilters(restrictTo(baseQuery(), 'f.project_id', ids), query), query.tab, now)
    .orderBy('f.due_at', query.tab === 'completed' ? 'desc' : 'asc').orderBy('f.id').limit(p.limit).offset(p.offset);
  const c = await applyFilters(restrictTo(db('project_follow_ups as f').join('projects as p', 'p.id', 'f.project_id'), 'f.project_id', ids), query)
    .first(db.raw(`
      count(*) filter (where not f.done and f.due_at >= ? and f.due_at < ?)::int as today,
      count(*) filter (where not f.done and f.due_at >= ?)::int as upcoming,
      count(*) filter (where not f.done and f.due_at < ?)::int as overdue,
      count(*) filter (where f.done)::int as completed,
      count(*)::int as "all"`, [new Date(T), new Date(T + DAY), new Date(T + DAY), new Date(now)]));
  return { items: rows.map(toProjectFollowUp), meta: { ...p.meta(c[query.tab]), counts: c } };
}

async function visibleProject(user, projectId, q = db) {
  const ids = await visibleProjectIds(user);
  const p = await prepo.findProject(projectId, q);
  if (!p || (ids && !ids.includes(p.id))) throw notFound('Project');
  return p;
}

async function readable(id, user, q = db) {
  const row = await baseQuery(q).where('f.id', id).first();
  if (!row) throw notFound('Follow-up');
  const ids = await visibleProjectIds(user);
  if (ids && !ids.includes(row.project_id)) throw notFound('Follow-up');
  return row;
}

export const get = async (id, user) => toProjectFollowUp(await readable(id, user));

function dueOf(v) {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

async function checkOwner(trx, ownerId) {
  const m = await trx('members').where({ id: ownerId }).first('id', 'active');
  if (!m) throw unprocessable('Pick who this follow-up is assigned to.');
  return m.id;
}

export async function create(b, user) {
  if (!b.title.trim()) throw unprocessable('Add a title.');
  const due = dueOf(b.dueAt);
  if (!due) throw unprocessable('Pick a date and time.');
  const id = await db.transaction(async (trx) => {
    const p = await visibleProject(user, b.projectId, trx);
    const owner = await checkOwner(trx, b.ownerId || user.memberId || p.pmId);
    const [dur, remind] = FU_DEFAULTS[b.type] || [0, 0];
    const fid = await nextId(trx, 'projectFollowUp');
    await trx('project_follow_ups').insert({
      id: fid,
      project_id: p.id,
      type: b.type,
      title: b.title.trim(),
      owner_member_id: owner,
      due_at: due,
      duration_min: b.durationMin ?? dur,
      remind_min: b.remindMin ?? remind,
      priority: b.priority || 'Medium',
      meet_url: b.meetUrl || '',
      attendees: b.attendees || '',
      notes: b.notes || '',
      created_by: user.id,
    });
    return fid;
  });
  return get(id, user);
}

export async function update(id, b, user) {
  await db.transaction(async (trx) => {
    const f = await readable(id, user, trx);
    const patch = { notified: false };
    if (b.title !== undefined) {
      if (!b.title.trim()) throw unprocessable('Add a title.');
      patch.title = b.title.trim();
    }
    if (b.dueAt !== undefined) {
      const due = dueOf(b.dueAt);
      if (!due) throw unprocessable('Pick a date and time.');
      patch.due_at = due;
    }
    if (b.projectId !== undefined && b.projectId !== f.project_id) patch.project_id = (await visibleProject(user, b.projectId, trx)).id;
    if (b.ownerId !== undefined && b.ownerId !== f.owner_member_id) patch.owner_member_id = await checkOwner(trx, b.ownerId);
    if (b.type !== undefined) patch.type = b.type;
    if (b.durationMin !== undefined) patch.duration_min = b.durationMin;
    if (b.remindMin !== undefined) patch.remind_min = b.remindMin;
    if (b.priority !== undefined) patch.priority = b.priority;
    if (b.meetUrl !== undefined) patch.meet_url = b.meetUrl;
    if (b.attendees !== undefined) patch.attendees = b.attendees;
    if (b.notes !== undefined) patch.notes = b.notes;
    await trx('project_follow_ups').where({ id }).update(patch);
  });
  return get(id, user);
}

export async function toggleDone(id, user) {
  await db.transaction(async (trx) => {
    const f = await readable(id, user, trx);
    await trx('project_follow_ups').where({ id }).update({ done: !f.done });
  });
  return get(id, user);
}

export async function remove(id, user) {
  await db.transaction(async (trx) => {
    const f = await readable(id, user, trx);
    const p = await prepo.findProject(f.project_id, trx);
    const mine = f.created_by === user.id || (!!user.memberId && f.owner_member_id === user.memberId);
    if (!mine && !isPMof(user, p)) throw forbidden('Only the person who added it, its owner or the project manager can delete this follow-up.');
    await trx('project_follow_ups').where({ id }).del();
  });
}
