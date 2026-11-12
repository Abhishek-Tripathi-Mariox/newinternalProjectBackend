/**
 * Follow-ups — port of frontend saveFu / toggleFu / delFu / checkReminders and the follow-up
 * page filters (features/followups/model.js). Scope comes from the `fu` permission.
 */
import { db } from '../../db/knex.js';
import { nextId } from '../../core/ids.js';
import { peopleScope, restrictTo } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams, sortParam } from '../../core/http.js';
import { DAY, parseDay, sod } from '../leads/leads.util.js';
import { toFollowUp } from './followups.mapper.js';
import { FU_DEFAULTS } from './followups.schemas.js';

const people = async (user) => (await peopleScope(user, 'fu')).people;

const baseQuery = (q = db) => q('follow_ups as f').leftJoin('leads as l', 'l.id', 'f.lead_id')
  .select('f.*', 'l.company as lead_company', 'l.contact as lead_contact');

function applyFilters(q, f) {
  if (f.type) q.where('f.type', f.type);
  if (f.owner) q.where('f.owner_id', f.owner);
  if (f.priority) q.where('f.priority', f.priority);
  if (f.leadId) q.where('f.lead_id', f.leadId);
  if (f.meet === 'yes') q.whereNot('f.meet_url', '');
  if (f.meet === 'no') q.where('f.meet_url', '');
  if (f.from) q.where('f.due_at', '>=', new Date(parseDay(f.from)));
  if (f.to) q.where('f.due_at', '<', new Date(parseDay(f.to) + DAY));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    q.where((w) => w.whereILike('f.title', like).orWhereILike('l.company', like));
  }
  return q;
}

/** Tab predicates (frontend FU_TABS). */
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

const SORT = { due: 'f.due_at', created: 'f.created_at', priority: 'f.priority', title: 'f.title', type: 'f.type' };

export async function list(query, user) {
  const now = Date.now();
  const T = sod(now);
  const ppl = await people(user);
  const scoped = () => applyFilters(restrictTo(db('follow_ups as f').leftJoin('leads as l', 'l.id', 'f.lead_id'), 'f.owner_id', ppl), query);

  const p = pageParams(query);
  const [col, dir] = sortParam(query.sort, SORT, ['f.due_at', 'asc']);
  const rows = await applyTab(applyFilters(restrictTo(baseQuery(), 'f.owner_id', ppl), query), query.tab, now)
    .orderBy(col, dir).orderBy('f.id').limit(p.limit).offset(p.offset);

  // Counts per tab (with every other filter applied) for the tab badges.
  const c = await scoped().first(db.raw(`
    count(*) filter (where not f.done and f.due_at >= ? and f.due_at < ?)::int as today,
    count(*) filter (where not f.done and f.due_at >= ?)::int as upcoming,
    count(*) filter (where not f.done and f.due_at < ?)::int as overdue,
    count(*) filter (where f.done)::int as completed,
    count(*)::int as "all"`, [new Date(T), new Date(T + DAY), new Date(T + DAY), new Date(now)]));
  return { items: rows.map((r) => toFollowUp(r)), meta: { ...p.meta(c[query.tab]), counts: c } };
}

async function readable(id, user) {
  const row = await baseQuery().where('f.id', id).first();
  const ppl = await people(user);
  if (!row || (ppl && !ppl.includes(row.owner_id))) throw notFound('Follow-up');
  return row;
}

async function writable(trx, id, user) {
  const row = await trx('follow_ups').where({ id }).forUpdate().first();
  if (!row) throw notFound('Follow-up');
  const ppl = await people(user);
  if (ppl && !ppl.includes(row.owner_id)) throw forbidden();
  return row;
}

export const get = async (id, user) => toFollowUp(await readable(id, user));

/** Due time from `dueAt` (ISO) or the modal's local `date` + `time`; null when missing/invalid. */
function dueOf(m) {
  let d = null;
  if (m.dueAt) d = new Date(m.dueAt);
  else if (m.date && m.time) d = new Date(`${m.date}T${m.time}`);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** Owner for a write: own scope → always yourself; team scope → someone in your team. */
async function resolveOwner(trx, wanted, user) {
  const { scope, people: ppl } = await peopleScope(user, 'fu');
  let owner = wanted || user.ownerId;
  if (scope === 'own') {
    if (wanted && wanted !== user.pid) throw forbidden();
    owner = user.ownerId || user.pid;
  } else if (ppl && owner && !ppl.includes(owner)) {
    throw forbidden();
  }
  if (!owner || !(await trx('sales_owners').where({ id: owner }).first('id'))) throw unprocessable('Pick a valid owner.');
  return owner;
}

async function checkLead(trx, leadId) {
  if (leadId && !(await trx('leads').where({ id: leadId }).first('id'))) throw unprocessable('Pick a valid lead.');
}

export async function create(m, user) {
  if (!m.title.trim()) throw unprocessable('Add a title.');
  const due = dueOf(m);
  if (!due) throw unprocessable('Pick a date and time.');
  const id = await db.transaction(async (trx) => {
    const owner = await resolveOwner(trx, m.ownerId, user);
    await checkLead(trx, m.leadId);
    const [dur, remind] = FU_DEFAULTS[m.type] || [0, 0];
    const fid = await nextId(trx, 'followUp');
    await trx('follow_ups').insert({
      id: fid,
      type: m.type,
      title: m.title.trim(),
      lead_id: m.leadId || null,
      owner_id: owner,
      due_at: due,
      duration_min: m.durationMin ?? dur,
      remind_min: m.remindMin ?? remind,
      priority: m.priority || 'Medium',
      meet_url: m.meetUrl || '',
      attendees: m.attendees || '',
      notes: m.notes || '',
      done: false,
      notified: false,
    });
    return fid;
  });
  return get(id, user);
}

export async function update(id, m, user) {
  await db.transaction(async (trx) => {
    const f = await writable(trx, id, user);
    if (m.title !== undefined && !m.title.trim()) throw unprocessable('Add a title.');
    const timeGiven = m.dueAt !== undefined || m.date !== undefined || m.time !== undefined;
    const due = timeGiven ? dueOf(m) : f.due_at;
    if (!due) throw unprocessable('Pick a date and time.');
    const patch = { due_at: due, notified: false };
    if (m.ownerId !== undefined && m.ownerId !== f.owner_id) patch.owner_id = await resolveOwner(trx, m.ownerId, user);
    if (m.leadId !== undefined) {
      await checkLead(trx, m.leadId);
      patch.lead_id = m.leadId || null;
    }
    if (m.type !== undefined) patch.type = m.type;
    if (m.title !== undefined) patch.title = m.title.trim();
    if (m.durationMin !== undefined) patch.duration_min = m.durationMin;
    if (m.remindMin !== undefined) patch.remind_min = m.remindMin;
    if (m.priority !== undefined) patch.priority = m.priority;
    if (m.meetUrl !== undefined) patch.meet_url = m.meetUrl;
    if (m.attendees !== undefined) patch.attendees = m.attendees;
    if (m.notes !== undefined) patch.notes = m.notes;
    await trx('follow_ups').where({ id }).update(patch);
  });
  return get(id, user);
}

export async function toggleDone(id, user) {
  await db.transaction(async (trx) => {
    const f = await writable(trx, id, user);
    await trx('follow_ups').where({ id }).update({ done: !f.done });
  });
  return get(id, user);
}

export async function remove(id, user) {
  await db.transaction(async (trx) => {
    await writable(trx, id, user);
    await trx('follow_ups').where({ id }).del();
  });
}

/** Follow-ups entering their reminder window: not done, not notified, remind > 0, now ∈ [due − remind, due + 5 min). */
export async function dueReminders(user) {
  const s = await db('settings').where({ key: 'reminderAlerts' }).first('value');
  if (s && s.value === false) return [];
  const rows = await restrictTo(baseQuery(), 'f.owner_id', await people(user))
    .where('f.done', false).where('f.notified', false).where('f.remind_min', '>', 0)
    .whereRaw("now() >= f.due_at - f.remind_min * interval '1 minute'")
    .whereRaw("now() < f.due_at + interval '5 minutes'")
    .orderBy('f.due_at');
  return rows.map((r) => toFollowUp(r));
}

/** Mark reminders as shown (only ones in the user's scope). */
export async function ackReminders(ids, user) {
  const updated = await restrictTo(db('follow_ups').whereIn('id', ids), 'owner_id', await people(user))
    .update({ notified: true }).returning('id');
  return { ids: updated.map((r) => r.id) };
}
